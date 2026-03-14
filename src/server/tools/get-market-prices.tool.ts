import { MarketPricesResult } from '../agent.types';
import { fetchYahooQuote, toYahooSymbol } from '../lib/yahoo';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetMarketPricesTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getMarketPrices',
    description:
      'Retrieves current market prices for stocks and cryptocurrencies. Supports stock tickers (e.g. AAPL, MSFT, GOOGL) and crypto symbols (e.g. BTC, ETH, SOL or BTC-USD, ETH-USD).',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of ticker symbols: stocks (e.g. ["AAPL", "MSFT"]) and/or crypto (e.g. ["BTC", "ETH"] or ["BTC-USD", "ETH-USD"])'
        }
      },
      required: ['symbols']
    }
  };

  public async execute(
    input: Record<string, unknown>,
    _context: ToolContext
  ): Promise<MarketPricesResult> {
    const rawSymbols = (input.symbols as string[]) ?? [];
    const yahooSymbols = rawSymbols.map((s) => toYahooSymbol(s));
    const now = new Date().toISOString().split('T')[0];

    const rows = yahooSymbols.map((yahooSymbol, i) => {
      const displaySymbol = (rawSymbols[i] ?? yahooSymbol).trim().toUpperCase();
      const quote = fetchYahooQuote(yahooSymbol);
      if (quote) {
        return {
          symbol: displaySymbol,
          price: { currency: quote.currency, amount: quote.price },
          asOf: now,
          source: 'Yahoo Finance'
        };
      }
      return {
        symbol: displaySymbol,
        price: { currency: 'USD', amount: 0 },
        asOf: now,
        source: 'unavailable'
      };
    });

    return { rows, asOf: now, source: 'Yahoo Finance' };
  }
}
