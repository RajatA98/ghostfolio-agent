import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { GhostfolioActivity, PaperTradeResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PortfolioTradeTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'logPaperTrade',
    description:
      'Logs a simulated buy or sell to the user\'s Ghostfolio portfolio. ONLY call after explicit user confirmation. Always present full trade details and wait for "yes"/"confirm" before calling.',
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

  constructor(private readonly portfolioService: GhostfolioPortfolioService) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PaperTradeResult> {
    const symbol = String(input.symbol).toUpperCase();
    const side = String(input.side).toUpperCase() as 'BUY' | 'SELL';
    const quantity = Number(input.quantity);
    const unitPrice = Number(input.unitPrice);
    const currency = String(input.currency ?? 'USD');

    if (!symbol || !['BUY', 'SELL'].includes(side) || quantity <= 0 || unitPrice <= 0) {
      throw new Error('Invalid trade parameters: symbol, side (BUY/SELL), quantity > 0, unitPrice > 0 required');
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
}
