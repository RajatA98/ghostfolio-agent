import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { GhostfolioActivity, PortfolioReadResult } from '../agent.types';
import { GhostfolioAuthService } from './ghostfolio-auth.service';

/**
 * Reads portfolio data from Ghostfolio and logs activities.
 * All methods take userId and fetch JWT internally via GhostfolioAuthService.
 */
export class GhostfolioPortfolioService {
  private readonly authService: GhostfolioAuthService;

  constructor(authService?: GhostfolioAuthService) {
    this.authService = authService ?? new GhostfolioAuthService();
  }

  private get baseUrl(): string {
    return (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
  }

  /**
   * Read the user's portfolio holdings from Ghostfolio.
   * When jwt is provided (e.g. from request context), use it; otherwise resolve via authService.
   */
  async getPortfolioData(userId: string, jwt?: string): Promise<PortfolioReadResult> {
    const token = jwt ?? (await this.authService.getJwt(userId));
    const res = await fetch(`${this.baseUrl}/api/v1/portfolio/holdings`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ghostfolio holdings API ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { holdings?: Array<Record<string, unknown>> };
    const holdings = (data.holdings ?? []).map((h) => ({
      symbol: String(h.symbol ?? ''),
      name: h.name ? String(h.name) : null,
      quantity: Number(h.quantity ?? 0),
      marketPrice: Number(h.marketPrice ?? 0),
      marketValue: Number(h.value ?? h.marketValue ?? 0),
      currency: String(h.currency ?? 'USD'),
      allocationPercent: Number(h.allocationInPercentage ?? h.allocation ?? 0) * 100
    }));

    const totalValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);

    return {
      holdings,
      totalValue: { currency: 'USD', amount: totalValue },
      asOf: new Date().toISOString().split('T')[0]
    };
  }

  /**
   * Get portfolio performance metrics.
   * Uses v2 API which requires a range parameter.
   */
  async getPerformance(userId: string, jwt?: string, range = 'max'): Promise<unknown> {
    const token = jwt ?? (await this.authService.getJwt(userId));
    const res = await fetch(`${this.baseUrl}/api/v2/portfolio/performance?range=${encodeURIComponent(range)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ghostfolio performance API ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * Get portfolio summary statistics.
   * Ghostfolio no longer has a dedicated summary endpoint — derive from holdings + performance.
   */
  async getSummary(userId: string, jwt?: string): Promise<unknown> {
    const token = jwt ?? (await this.authService.getJwt(userId));
    // Fetch holdings and performance to build a summary
    const [holdingsData, perfData] = await Promise.all([
      this.getPortfolioData(userId, token),
      this.getPerformance(userId, token, 'max')
    ]);
    const perf = perfData as { performance?: { netPerformancePercentage?: number } };
    return {
      holdings: (holdingsData as { holdings?: unknown[] }).holdings ?? [],
      totalValue: (holdingsData as { totalValue?: unknown }).totalValue,
      asOf: (holdingsData as { asOf?: string }).asOf,
      netPerformancePercentage: perf.performance?.netPerformancePercentage ?? null,
      source: 'derived from holdings + performance'
    };
  }

  /**
   * Get all activities/orders, optionally filtered by account.
   */
  async getActivities(userId: string, accountId?: string, jwt?: string): Promise<unknown> {
    const token = jwt ?? (await this.authService.getJwt(userId));
    const url = accountId
      ? `${this.baseUrl}/api/v1/order?accounts=${accountId}`
      : `${this.baseUrl}/api/v1/order`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ghostfolio activities API ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * Delete a specific activity by ID.
   */
  async deleteActivity(userId: string, activityId: string): Promise<void> {
    const jwt = await this.authService.getJwt(userId);
    const res = await fetch(`${this.baseUrl}/api/v1/order/${activityId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ghostfolio delete activity ${res.status}: ${text}`);
    }
  }

  /**
   * Resolve the user's Ghostfolio account ID.
   * Uses the configured default, or fetches the first account from Ghostfolio.
   */
  private async resolveAccountId(token: string): Promise<string | undefined> {
    if (agentConfig.defaultAccountId) {
      return agentConfig.defaultAccountId;
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/account`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { accounts?: Array<{ id: string }> };
      const accounts = data.accounts ?? (Array.isArray(data) ? data : []);
      return (accounts as Array<{ id: string }>)[0]?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Log an activity (paper trade or brokerage sync) to Ghostfolio.
   * When jwt is provided directly (dev mode), skips Prisma and DB operations.
   * In production, creates a local Order record with status tracking.
   */
  async logActivity(
    userId: string,
    activity: GhostfolioActivity,
    jwt?: string
  ): Promise<{ orderId: string; ghostfolioActivityId: string | null; status: 'logged' | 'failed' }> {
    const token = jwt ?? await this.authService.getJwt(userId);
    const orderId = `paper-${Date.now()}`;

    // In dev mode (jwt provided directly), skip Prisma
    const useDb = !jwt && agentConfig.databaseUrl;
    let dbOrderId = orderId;

    if (useDb) {
      const prisma = getPrisma();
      const order = await prisma.order.create({
        data: {
          userId,
          symbol: activity.symbol.toUpperCase(),
          side: activity.type,
          qty: activity.quantity,
          unitPrice: activity.unitPrice,
          currency: activity.currency ?? 'USD',
          status: 'pending'
        }
      });
      dbOrderId = order.id;
    }

    // Resolve accountId: use activity's, config default, or fetch from Ghostfolio
    const resolvedAccountId = activity.accountId || await this.resolveAccountId(token);

    try {
      const body = {
        accountId: resolvedAccountId,
        comment: `Via agent (order: ${dbOrderId})`,
        currency: activity.currency ?? 'USD',
        dataSource: activity.dataSource ?? 'YAHOO',
        date: activity.date ?? new Date().toISOString(),
        fee: activity.fee ?? 0,
        quantity: activity.quantity,
        symbol: activity.symbol.toUpperCase(),
        type: activity.type,
        unitPrice: activity.unitPrice
      };

      const res = await fetch(`${this.baseUrl}/api/v1/order`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ghostfolio order API ${res.status}: ${text}`);
      }

      const data = (await res.json()) as { id?: string };
      const ghostfolioActivityId = data.id ?? null;

      if (useDb) {
        const prisma = getPrisma();
        await prisma.order.update({
          where: { id: dbOrderId },
          data: { status: 'logged', ghostfolioActivityId }
        });
      }

      return { orderId: dbOrderId, ghostfolioActivityId, status: 'logged' };
    } catch (err) {
      if (useDb) {
        const prisma = getPrisma();
        const errorMessage = err instanceof Error ? err.message : String(err);
        await prisma.order.update({
          where: { id: dbOrderId },
          data: { status: 'failed', errorMessage }
        });
      }
      return { orderId: dbOrderId, ghostfolioActivityId: null, status: 'failed' };
    }
  }
}
