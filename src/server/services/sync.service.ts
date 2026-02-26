import { agentConfig } from '../agent.config';
import { SyncToGhostfolioResult } from '../agent.types';

/**
 * Syncs Plaid holdings into Ghostfolio as BUY activities.
 * Alpaca sync has been removed — paper trades go directly via GhostfolioPortfolioService.
 */
export class SyncService {
  private get baseUrl(): string {
    return (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
  }

  async syncPlaidHoldingsToGhostfolio(params: {
    userId: string;
    holdings: Array<{
      symbol: string;
      quantity: number;
      costBasis: number | null;
      currency: string;
    }>;
    jwt: string;
    accountId: string;
  }): Promise<SyncToGhostfolioResult> {
    const { holdings, jwt, accountId } = params;
    let activitiesCreated = 0;
    const errors: string[] = [];

    for (const holding of holdings) {
      try {
        const unitPrice = holding.costBasis
          ? holding.costBasis / (holding.quantity || 1)
          : 0;

        const body: Record<string, unknown> = {
          accountId: accountId || agentConfig.defaultAccountId || undefined,
          comment: 'Synced from Plaid brokerage',
          currency: holding.currency || 'USD',
          date: new Date().toISOString(),
          fee: 0,
          quantity: holding.quantity,
          symbol: holding.symbol,
          type: 'BUY',
          unitPrice
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
          errors.push(`${holding.symbol}: ${res.status} ${text}`);
        } else {
          activitiesCreated++;
        }
      } catch (err) {
        errors.push(
          `${holding.symbol}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { activitiesCreated, errors };
  }
}
