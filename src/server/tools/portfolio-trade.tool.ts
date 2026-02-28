import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { GhostfolioActivity, PaperTradeResult } from '../agent.types';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

export class PortfolioTradeTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'logPaperTrade',
    description:
      'Logs one paper trade to Ghostfolio. Single responsibility. Not idempotent—call only once per confirmed trade; safe to retry only if the previous call failed. Only call after explicit user confirmation. Returns structured result; on failure status is FAILED and error field is set.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: {
          type: 'string',
          description: 'Ticker symbol (e.g. AAPL, MSFT, BTC)'
        },
        side: {
          type: 'string',
          enum: ['BUY', 'SELL'],
          description: 'Trade direction: BUY or SELL'
        },
        quantity: {
          type: 'number',
          description: 'Number of shares/units to trade'
        },
        unitPrice: {
          type: 'number',
          description: 'Price per share/unit in the given currency'
        },
        currency: {
          type: 'string',
          description: 'Currency code (default: USD)'
        }
      },
      required: ['symbol', 'side', 'quantity', 'unitPrice']
    }
  };

  constructor(private readonly portfolioService: GhostfolioPortfolioService) {
    super();
  }

  protected async run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PaperTradeResult> {
    const symbol = String(input.symbol).toUpperCase();
    const side = String(input.side).toUpperCase() as 'BUY' | 'SELL';
    const quantity = Number(input.quantity);
    const unitPrice = Number(input.unitPrice);
    const currency = String(input.currency ?? 'USD');

    if (!symbol || !['BUY', 'SELL'].includes(side) || quantity <= 0 || unitPrice <= 0) {
      return {
        orderId: `paper-invalid-${Date.now()}`,
        symbol: symbol || 'UNKNOWN',
        side: side || 'BUY',
        quantity,
        unitPrice,
        currency,
        status: 'FAILED',
        ghostfolioSynced: false,
        error: 'Invalid trade parameters: symbol, side (BUY/SELL), quantity > 0, unitPrice > 0 required'
      };
    }

    const activity: GhostfolioActivity = {
      accountId: '',  // uses default from config
      currency,
      dataSource: 'YAHOO',
      date: new Date().toISOString(),
      fee: 0,
      quantity,
      symbol,
      type: side,
      unitPrice
    };

    const result = await this.portfolioService.logActivity(context.userId, activity, context.jwt);
    return {
      orderId: result.orderId,
      symbol,
      side,
      quantity,
      unitPrice,
      currency,
      status: result.status === 'logged' ? 'FILLED' : 'FAILED',
      ghostfolioSynced: result.status === 'logged'
    };
  }

  protected onError(
    error: unknown,
    _input: Record<string, unknown>,
    _context: ToolContext
  ): PaperTradeResult {
    return {
      orderId: `paper-failed-${Date.now()}`,
      symbol: 'UNKNOWN',
      side: 'BUY',
      quantity: 0,
      unitPrice: 0,
      currency: 'USD',
      status: 'FAILED',
      ghostfolioSynced: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
