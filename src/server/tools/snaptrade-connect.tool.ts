import { SnapTradeService } from '../services/snaptrade.service';
import { ConnectBrokerageResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class SnapTradeConnectTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'connectBrokerage',
    description:
      "Initiates a connection to the user's brokerage account via SnapTrade. Returns a redirect URL that opens the SnapTrade Connection Portal where the user can link their brokerage (Robinhood, Fidelity, Schwab, etc.) with read-only access.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  };

  constructor(private readonly snapTradeService: SnapTradeService) {}

  public async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ConnectBrokerageResult> {
    // Ensure user is registered (idempotent)
    const supabaseUserId = context.supabaseUserId ?? context.userId;
    await this.snapTradeService.registerUser(context.userId, supabaseUserId);
    const result = await this.snapTradeService.getConnectUrl(context.userId, supabaseUserId);
    return { redirectURI: result.redirectURI };
  }
}
