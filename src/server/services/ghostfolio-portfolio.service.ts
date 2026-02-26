import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { PaperTradeInput, PortfolioReadResult } from '../agent.types';

/**
 * Reads portfolio data from Ghostfolio and logs paper trades as activities.
 */
export class GhostfolioPortfolioService {
  private get baseUrl(): string {
    return (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
  }

  /**
   * Read the user's portfolio holdings from Ghostfolio.
   */
  async getPortfolioData(jwt: string): Promise<PortfolioReadResult> {
    const res = await fetch(`${this.baseUrl}/api/v1/portfolio/holdings`, {
      headers: { Authorization: `Bearer ${jwt}` }
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
   * Log a paper trade as a Ghostfolio activity (POST /api/v1/order).
   * This is how paper trades work — they go directly into Ghostfolio as activities.
   */
  async logPaperTrade(
    userId: string,
    trade: PaperTradeInput,
    jwt: string,
    accountId?: string
  ): Promise<{ orderId: string; ghostfolioSynced: boolean }> {
    const prisma = getPrisma();
    const now = new Date();

    // Create local order record
    const order = await prisma.order.create({
      data: {
        userId,
        symbol: trade.symbol.toUpperCase(),
        side: trade.side,
        quantity: trade.quantity,
        unitPrice: trade.unitPrice,
        currency: trade.currency ?? 'USD',
        type: 'MARKET',
        status: 'FILLED'
      }
    });

    // Post to Ghostfolio as an activity
    try {
      const body: Record<string, unknown> = {
        accountId: accountId || agentConfig.defaultAccountId || undefined,
        comment: `Paper trade via agent (order: ${order.id})`,
        currency: trade.currency ?? 'USD',
        date: now.toISOString(),
        fee: 0,
        quantity: trade.quantity,
        symbol: trade.symbol.toUpperCase(),
        type: trade.side,
        unitPrice: trade.unitPrice
      };

      const res = await fetch(`${this.baseUrl}/api/v1/order`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ghostfolio order API ${res.status}: ${text}`);
      }

      await prisma.order.update({
        where: { id: order.id },
        data: { ghostfolioSynced: true }
      });

      return { orderId: order.id, ghostfolioSynced: true };
    } catch (err) {
      // Order exists locally but failed to sync to Ghostfolio
      return { orderId: order.id, ghostfolioSynced: false };
    }
  }
}
