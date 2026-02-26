import { SyncService } from '../services/sync.service';
import { SyncResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PlaidSyncTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'syncBrokerageHoldings',
    description:
      "Syncs holdings from connected real brokerage accounts into Ghostfolio. Use when user wants to refresh their real portfolio data. Deduplicates automatically — only new holdings are added.",
    input_schema: {
      type: 'object' as const,
      properties: {
        itemId: {
          type: 'string',
          description:
            'The Plaid item ID to sync holdings from. If omitted, syncs all connected brokerages.'
        }
      },
      required: []
    }
  };

  constructor(private readonly syncService: SyncService) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<SyncResult> {
    const itemId = input.itemId ? String(input.itemId) : '';
    if (!itemId) {
      throw new Error('itemId is required for sync. List connected brokerages first.');
    }
    return this.syncService.syncHoldingsToGhostfolio(context.userId, itemId);
  }
}
