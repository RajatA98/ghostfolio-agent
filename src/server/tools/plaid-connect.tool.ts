import { PlaidService } from '../services/plaid.service';
import { ConnectBrokerageResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PlaidConnectTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'connectBrokerage',
    description:
      "Initiates a connection to the user's brokerage account via Plaid. Returns a link_token that the frontend uses to open the Plaid Link modal. The user will select their brokerage and authorize read-only access to investment data.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  };

  constructor(private readonly plaidService: PlaidService) {}

  public async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ConnectBrokerageResult> {
    const result = await this.plaidService.createLinkToken(context.userId);
    return {
      linkToken: result.linkToken,
      expiration: result.expiration
    };
  }
}
