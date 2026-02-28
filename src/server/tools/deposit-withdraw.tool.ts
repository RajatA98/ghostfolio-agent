import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { FundMovementResult, GhostfolioActivity } from '../agent.types';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

export class DepositWithdrawTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'logFundMovement',
    description:
      'Deposits or withdraws simulated funds in the user\'s Ghostfolio portfolio. Not idempotent — call only once per confirmed movement; safe to retry only if the previous call failed. Only call after explicit user confirmation. Returns structured result; on failure status is FAILED and error field is set.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['DEPOSIT', 'WITHDRAWAL'],
          description: 'Fund movement direction: DEPOSIT to add cash, WITHDRAWAL to remove cash'
        },
        amount: {
          type: 'number',
          description: 'The cash amount to deposit or withdraw'
        },
        currency: {
          type: 'string',
          description: 'Currency code (default: USD)'
        }
      },
      required: ['type', 'amount']
    }
  };

  constructor(private readonly portfolioService: GhostfolioPortfolioService) {
    super();
  }

  protected async run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<FundMovementResult> {
    const type = String(input.type).toUpperCase() as 'DEPOSIT' | 'WITHDRAWAL';
    const amount = Number(input.amount);
    const currency = String(input.currency ?? 'USD').toUpperCase();

    if (!['DEPOSIT', 'WITHDRAWAL'].includes(type) || amount <= 0) {
      return {
        movementId: `fund-invalid-${Date.now()}`,
        type: type || 'DEPOSIT',
        amount,
        currency,
        status: 'FAILED',
        ghostfolioSynced: false,
        error: 'Invalid parameters: type must be DEPOSIT or WITHDRAWAL, amount must be > 0'
      };
    }

    const activity: GhostfolioActivity = {
      accountId: '',
      currency,
      dataSource: 'MANUAL',
      date: new Date().toISOString(),
      fee: 0,
      quantity: amount,
      symbol: currency,
      type,
      unitPrice: 1
    };

    const result = await this.portfolioService.logActivity(context.userId, activity, context.jwt);
    return {
      movementId: result.orderId,
      type,
      amount,
      currency,
      status: result.status === 'logged' ? 'COMPLETED' : 'FAILED',
      ghostfolioSynced: result.status === 'logged'
    };
  }

  protected onError(
    error: unknown,
    _input: Record<string, unknown>,
    _context: ToolContext
  ): FundMovementResult {
    return {
      movementId: `fund-failed-${Date.now()}`,
      type: 'DEPOSIT',
      amount: 0,
      currency: 'USD',
      status: 'FAILED',
      ghostfolioSynced: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
