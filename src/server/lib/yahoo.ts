import { execSync } from 'node:child_process';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** In-memory cache: symbol → { price, currency, ts } */
export const priceCache = new Map<
  string,
  { price: number; currency: string; ts: number }
>();
export const CACHE_TTL_MS = 60_000; // 1 minute

/** Yahoo Finance uses BTC-USD, ETH-USD etc. for crypto. */
export const CRYPTO_TO_YAHOO: Record<string, string> = {
  BTC: 'BTC-USD',  ETH: 'ETH-USD',  SOL: 'SOL-USD',  XRP: 'XRP-USD',
  ADA: 'ADA-USD',  DOGE: 'DOGE-USD', AVAX: 'AVAX-USD', DOT: 'DOT-USD',
  MATIC: 'MATIC-USD', LINK: 'LINK-USD', UNI: 'UNI-USD', LTC: 'LTC-USD',
  BCH: 'BCH-USD',  ATOM: 'ATOM-USD', XLM: 'XLM-USD',  VET: 'VET-USD',
  FIL: 'FIL-USD',  TRX: 'TRX-USD',  ETC: 'ETC-USD',  XMR: 'XMR-USD',
  NEAR: 'NEAR-USD', APT: 'APT-USD',  ARB: 'ARB-USD',  OP: 'OP-USD',
  INJ: 'INJ-USD',  SUI: 'SUI-USD',  SEI: 'SEI-USD',  TIA: 'TIA-USD',
  PEPE: 'PEPE-USD', SHIB: 'SHIB-USD'
};

export function toYahooSymbol(symbol: string): string {
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
export function fetchYahooQuote(
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
