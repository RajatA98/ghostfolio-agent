import { MarketPricesResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetMarketPricesTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getMarketPrices',
    description:
      'Retrieves current market prices for given ticker symbols. Note: This tool is currently disabled and will be available in a future update.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of ticker symbols to get prices for (e.g. ["AAPL", "MSFT"])'
        }
      },
      required: ['symbols']
    }
  };

  public async execute(
    input: Record<string, unknown>,
    _context: ToolContext
  ): Promise<MarketPricesResult> {
    const symbols = (input.symbols as string[]) ?? [];
    const now = new Date().toISOString().split('T')[0];

    return {
      rows: symbols.map((symbol) => ({
        symbol,
        price: { currency: 'USD', amount: 0 },
        asOf: now,
        source: 'unavailable'
      })),
      asOf: now,
      source:
        'Market prices tool is not currently enabled. Use portfolio snapshot data for available pricing.'
    };
  }
}
