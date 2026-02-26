import { execSync } from 'node:child_process';
import { MarketPricesResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** In-memory cache: symbol → { price, currency, ts } */
const priceCache = new Map<string, { price: number; currency: string; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/** Yahoo Finance uses BTC-USD, ETH-USD etc. for crypto. */
const CRYPTO_TO_YAHOO: Record<string, string> = {
  BTC: 'BTC-USD',  ETH: 'ETH-USD',  SOL: 'SOL-USD',  XRP: 'XRP-USD',
  ADA: 'ADA-USD',  DOGE: 'DOGE-USD', AVAX: 'AVAX-USD', DOT: 'DOT-USD',
  MATIC: 'MATIC-USD', LINK: 'LINK-USD', UNI: 'UNI-USD', LTC: 'LTC-USD',
  BCH: 'BCH-USD',  ATOM: 'ATOM-USD', XLM: 'XLM-USD',  VET: 'VET-USD',
  FIL: 'FIL-USD',  TRX: 'TRX-USD',  ETC: 'ETC-USD',  XMR: 'XMR-USD',
  NEAR: 'NEAR-USD', APT: 'APT-USD',  ARB: 'ARB-USD',  OP: 'OP-USD',
  INJ: 'INJ-USD',  SUI: 'SUI-USD',  SEI: 'SEI-USD',  TIA: 'TIA-USD',
  PEPE: 'PEPE-USD', SHIB: 'SHIB-USD'
};

function toYahooSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return CRYPTO_TO_YAHOO[upper] ?? upper;
}

/**
 * Fetch a quote from Yahoo Finance v8 chart API via curl.
 *
 * Why curl instead of fetch:
 * Node's built-in fetch (undici) gets 429'd by Yahoo Finance due to TLS
 * fingerprinting differences. curl with a browser User-Agent works reliably.
 * Results are cached for 1 minute to minimize requests during eval runs.
 */
function fetchYahooQuote(
  yahooSymbol: string
): { price: number; currency: string } | null {
  const cached = priceCache.get(yahooSymbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { price: cached.price, currency: cached.currency };
  }

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
    const raw = execSync(
      `/usr/bin/curl -s -H "User-Agent: ${USER_AGENT}" "${url}"`,
      { timeout: 10_000, encoding: 'utf-8', env: { PATH: '/usr/bin', HOME: '' } }
    );

    const data = JSON.parse(raw) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number; currency?: string };
        }>;
      };
    };

    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice || meta.regularMarketPrice <= 0) return null;

    const result = { price: meta.regularMarketPrice, currency: meta.currency ?? 'USD' };
    priceCache.set(yahooSymbol, { ...result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
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
