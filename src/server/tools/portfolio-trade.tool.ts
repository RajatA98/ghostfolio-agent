import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { PaperTradeResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PortfolioTradeTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'logPaperTrade',
    description:
      'Logs a paper trade (simulated BUY or SELL) into the portfolio. This creates a Ghostfolio activity record. The user MUST confirm the trade before you call this tool. Always get a current market price first using getMarketPrices.',
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

    const result = await this.portfolioService.logPaperTrade(
      context.userId,
      { symbol, side, quantity, unitPrice, currency },
      context.jwt
    );

    return {
      orderId: result.orderId,
      symbol,
      side,
      quantity,
      unitPrice,
      currency,
      status: 'FILLED',
      ghostfolioSynced: result.ghostfolioSynced
    };
  }
}
