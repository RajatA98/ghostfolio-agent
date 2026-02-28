import { execSync } from 'node:child_process';
import { StockOverviewResult, StockOverviewRow } from '../agent.types';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** In-memory cache: symbol → { data, ts } */
const overviewCache = new Map<
  string,
  { data: StockOverviewRow; ts: number }
>();
const CACHE_TTL_MS = 300_000; // 5 minutes

/** Yahoo Finance uses BTC-USD, ETH-USD etc. for crypto. */
const CRYPTO_TO_YAHOO: Record<string, string> = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
  ADA: 'ADA-USD', DOGE: 'DOGE-USD', AVAX: 'AVAX-USD', DOT: 'DOT-USD',
  MATIC: 'MATIC-USD', LINK: 'LINK-USD', UNI: 'UNI-USD', LTC: 'LTC-USD',
  BCH: 'BCH-USD', ATOM: 'ATOM-USD', XLM: 'XLM-USD', VET: 'VET-USD',
  FIL: 'FIL-USD', TRX: 'TRX-USD', ETC: 'ETC-USD', XMR: 'XMR-USD',
  NEAR: 'NEAR-USD', APT: 'APT-USD', ARB: 'ARB-USD', OP: 'OP-USD',
  INJ: 'INJ-USD', SUI: 'SUI-USD', SEI: 'SEI-USD', TIA: 'TIA-USD',
  PEPE: 'PEPE-USD', SHIB: 'SHIB-USD'
};

function toYahooSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return CRYPTO_TO_YAHOO[upper] ?? upper;
}

interface YahooChartMeta {
  regularMarketPrice?: number;
  currency?: string;
  previousClose?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  marketCap?: number;
  regularMarketVolume?: number;
  averageDailyVolume10Day?: number;
  exchangeName?: string;
  instrumentType?: string;
}

/**
 * Fetch extended quote data from Yahoo Finance v8 chart API via curl.
 * Extracts fundamentals (52-week range, market cap, volume) from the same
 * endpoint used by getMarketPrices, but reads additional fields from meta.
 */
function fetchYahooOverview(
  yahooSymbol: string,
  displaySymbol: string,
  now: string
): StockOverviewRow | null {
  const cached = overviewCache.get(yahooSymbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?interval=1d&range=5d`;
    const raw = execSync(
      `/usr/bin/curl -s -H "User-Agent: ${USER_AGENT}" "${url}"`,
      { timeout: 10_000, encoding: 'utf-8', env: { PATH: '/usr/bin', HOME: '' } }
    );

    const data = JSON.parse(raw) as {
      chart?: {
        result?: Array<{ meta?: YahooChartMeta }>;
      };
    };

    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice || meta.regularMarketPrice <= 0) return null;

    const price = meta.regularMarketPrice;
    const previousClose = meta.previousClose ?? price;
    const dayChangePercent =
      previousClose > 0
        ? Math.round(((price - previousClose) / previousClose) * 10000) / 100
        : 0;

    const row: StockOverviewRow = {
      symbol: displaySymbol,
      price: { currency: meta.currency ?? 'USD', amount: price },
      previousClose,
      dayChangePercent,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? 0,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? 0,
      marketCap: meta.marketCap ?? null,
      avgVolume: meta.averageDailyVolume10Day ?? meta.regularMarketVolume ?? null,
      exchange: meta.exchangeName ?? null,
      assetType: meta.instrumentType ?? null,
      asOf: now,
      source: 'Yahoo Finance'
    };

    overviewCache.set(yahooSymbol, { data: row, ts: Date.now() });
    return row;
  } catch {
    return null;
  }
}

export class GetStockOverviewTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getStockOverview',
    description:
      'Fetches stock/crypto overview data: current price, 52-week high/low, market cap, average volume, day change %. Single responsibility: fundamentals lookup. Idempotent and safe to retry. Source: Yahoo Finance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of ticker symbols (e.g. ["AAPL", "MSFT"]) and/or crypto (e.g. ["BTC", "ETH"])'
        }
      },
      required: ['symbols']
    }
  };

  protected async run(
    input: Record<string, unknown>,
    _context: ToolContext
  ): Promise<StockOverviewResult> {
    const rawSymbols = (input.symbols as string[]) ?? [];
    const now = new Date().toISOString().split('T')[0];

    const rows: StockOverviewRow[] = [];
    for (let i = 0; i < rawSymbols.length; i++) {
      const displaySymbol = rawSymbols[i].trim().toUpperCase();
      const yahooSymbol = toYahooSymbol(rawSymbols[i]);
      const overview = fetchYahooOverview(yahooSymbol, displaySymbol, now);
      if (overview) {
        rows.push(overview);
      } else {
        rows.push({
          symbol: displaySymbol,
          price: { currency: 'USD', amount: 0 },
          previousClose: 0,
          dayChangePercent: 0,
          fiftyTwoWeekHigh: 0,
          fiftyTwoWeekLow: 0,
          marketCap: null,
          avgVolume: null,
          exchange: null,
          assetType: null,
          asOf: now,
          source: 'unavailable'
        });
      }
    }

    return { rows, asOf: now, source: 'Yahoo Finance' };
  }
}
