import { PlaidService } from '../services/plaid.service';
import { SyncService } from '../services/sync.service';
import { SyncToGhostfolioResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PlaidSyncTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'syncPortfolio',
    description:
      "Syncs investment holdings from connected brokerage accounts (via Plaid) into Ghostfolio as buy activities. This creates transaction records in Ghostfolio matching the user's real brokerage positions. The user must have connected a brokerage first.",
    input_schema: {
      type: 'object' as const,
      properties: {
        accountId: {
          type: 'string',
          description:
            'Ghostfolio account ID to sync into. Defaults to "default".'
        }
      },
      required: []
    }
  };

  constructor(
    private readonly plaidService: PlaidService,
    private readonly syncService: SyncService
  ) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<SyncToGhostfolioResult> {
    const accountId = String(input.accountId ?? 'default');
    const result = await this.plaidService.getInvestmentHoldings(
      context.userId
    );

    return this.syncService.syncPlaidHoldingsToGhostfolio({
      userId: context.userId,
      holdings: result.holdings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        costBasis: h.costBasis,
        currency: h.currency
      })),
      jwt: context.jwt,
      accountId
    });
  }
}
