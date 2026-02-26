import { MarketPricesResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

/** Yahoo Finance uses BTC-USD, ETH-USD etc. for crypto. Map common symbols to Yahoo tickers. */
const CRYPTO_TO_YAHOO: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  ADA: 'ADA-USD',
  DOGE: 'DOGE-USD',
  AVAX: 'AVAX-USD',
  DOT: 'DOT-USD',
  MATIC: 'MATIC-USD',
  LINK: 'LINK-USD',
  UNI: 'UNI-USD',
  LTC: 'LTC-USD',
  BCH: 'BCH-USD',
  ATOM: 'ATOM-USD',
  XLM: 'XLM-USD',
  VET: 'VET-USD',
  FIL: 'FIL-USD',
  TRX: 'TRX-USD',
  ETC: 'ETC-USD',
  XMR: 'XMR-USD',
  NEAR: 'NEAR-USD',
  APT: 'APT-USD',
  ARB: 'ARB-USD',
  OP: 'OP-USD',
  INJ: 'INJ-USD',
  SUI: 'SUI-USD',
  SEI: 'SEI-USD',
  TIA: 'TIA-USD',
  PEPE: 'PEPE-USD',
  SHIB: 'SHIB-USD'
};

function toYahooSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (CRYPTO_TO_YAHOO[upper]) return CRYPTO_TO_YAHOO[upper];
  // Already in form XXX-USD (crypto) or stock ticker
  return upper;
}

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

    let yahooFinance: { quote: (symbol: string) => Promise<{ regularMarketPrice?: number; currency?: string }> };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('yahoo-finance2') as { default?: typeof yahooFinance } & typeof yahooFinance;
      yahooFinance = mod.default ?? mod;
    } catch (e) {
      return {
        rows: rawSymbols.map((symbol) => ({
          symbol: symbol.trim().toUpperCase(),
          price: { currency: 'USD', amount: 0 },
          asOf: now,
          source: 'unavailable'
        })),
        asOf: now,
        source:
          'Market data unavailable: yahoo-finance2 could not be loaded. Run npm install.'
      };
    }

    const results = await Promise.allSettled(
      yahooSymbols.map((yahooSymbol) => yahooFinance.quote(yahooSymbol))
    );

    const rows = results.map((out, i) => {
      const displaySymbol = (rawSymbols[i] ?? yahooSymbols[i]).trim().toUpperCase();
      if (out.status === 'fulfilled' && out.value?.regularMarketPrice != null && out.value.regularMarketPrice > 0) {
        const q = out.value;
        return {
          symbol: displaySymbol,
          price: {
            currency: (q.currency as string) || 'USD',
            amount: q.regularMarketPrice as number
          },
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

    return {
      rows,
      asOf: now,
      source: 'Yahoo Finance'
    };
  }
}
