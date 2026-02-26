import { GhostfolioActivity, SyncResult } from '../agent.types';
import { getPrisma } from '../lib/prisma';
import { GhostfolioPortfolioService } from './ghostfolio-portfolio.service';
import { PlaidService } from './plaid.service';

/**
 * Syncs Plaid brokerage holdings into Ghostfolio as BUY activities.
 * Deduplicates by checking existing activities before creating new ones.
 */
export class SyncService {
  constructor(
    private readonly plaidService: PlaidService,
    private readonly portfolioService: GhostfolioPortfolioService
  ) {}

  /**
   * Sync holdings from a specific Plaid item into Ghostfolio.
   * Fetches existing activities first to avoid duplicates.
   */
  async syncHoldingsToGhostfolio(userId: string, itemId: string): Promise<SyncResult> {
    const prisma = getPrisma();
    const plaidItem = await prisma.plaidItem.findUnique({ where: { itemId } });

    if (!plaidItem) {
      throw new Error(`PlaidItem not found: ${itemId}`);
    }

    // Get holdings from Plaid
    const { holdings } = await this.plaidService.getHoldings(userId);

    // Get existing Ghostfolio activities for deduplication
    const existingSymbols = new Set<string>();
    if (plaidItem.ghostfolioAccountId) {
      try {
        const existingActivities = (await this.portfolioService.getActivities(
          userId,
          plaidItem.ghostfolioAccountId
        )) as { activities?: Array<{ symbol?: string }> };
        for (const a of existingActivities.activities ?? []) {
          if (a.symbol) existingSymbols.add(a.symbol.toUpperCase());
        }
      } catch {
        // If we can't fetch activities, sync everything (no dedup)
      }
    }

    let synced = 0;
    let skipped = 0;

    for (const holding of holdings) {
      const symbol = holding.symbol.toUpperCase();

      // Skip if already in Ghostfolio
      if (existingSymbols.has(symbol)) {
        skipped++;
        continue;
      }

      const unitPrice = holding.costBasis
        ? holding.costBasis / (holding.quantity || 1)
        : 0;

      const activity: GhostfolioActivity = {
        accountId: plaidItem.ghostfolioAccountId ?? '',
        currency: holding.currency ?? 'USD',
        dataSource: 'YAHOO',
        date: new Date().toISOString(),
        fee: 0,
        quantity: holding.quantity,
        symbol,
        type: 'BUY',
        unitPrice
      };

      const result = await this.portfolioService.logActivity(userId, activity);
      if (result.status === 'logged') {
        synced++;
      }
    }

    // Update lastSyncedAt
    await prisma.plaidItem.update({
      where: { itemId },
      data: { lastSyncedAt: new Date() }
    });

    return { synced, skipped };
  }
}
