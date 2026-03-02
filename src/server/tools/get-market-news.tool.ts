import { MarketNewsResult, NewsArticle } from '../agent.types';
import { agentConfig } from '../agent.config';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

/** In-memory cache: symbol → { articles, ts } */
const newsCache = new Map<
  string,
  { articles: NewsArticle[]; ts: number }
>();
const CACHE_TTL_MS = 300_000; // 5 minutes
const MAX_ARTICLES = 5;
const MAX_SUMMARY_LENGTH = 200;

/**
 * Format a date as YYYY-MM-DD.
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Fetch company news from Finnhub free API.
 * https://finnhub.io/docs/api/company-news
 * Free tier: 60 calls/min — plenty for agent use.
 */
async function fetchFinnhubNews(
  symbol: string,
  daysBack: number
): Promise<NewsArticle[]> {
  const cached = newsCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.articles;
  }

  const apiKey = agentConfig.finnhubApiKey;
  if (!apiKey) {
    return [];
  }

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);

  const url =
    `https://finnhub.io/api/v1/company-news` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&from=${formatDate(from)}` +
    `&to=${formatDate(to)}` +
    `&token=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      return [];
    }

    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) return [];

    const articles: NewsArticle[] = raw
      .slice(0, MAX_ARTICLES)
      .map((item: Record<string, unknown>) => {
        const dt = item.datetime;
        const dateStr =
          typeof dt === 'number' && Number.isFinite(dt)
            ? new Date(dt * 1000).toISOString().split('T')[0]
            : formatDate(new Date());
        return {
          headline: String(item.headline ?? ''),
          summary: String(item.summary ?? '').slice(0, MAX_SUMMARY_LENGTH),
          source: String(item.source ?? 'Unknown'),
          datetime: dateStr,
          url: String(item.url ?? '')
        };
      });

    newsCache.set(symbol, { articles, ts: Date.now() });
    return articles;
  } catch {
    return [];
  }
}

export class GetMarketNewsTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getMarketNews',
    description:
      'Fetches recent news articles for a stock symbol. Single responsibility: news lookup. Idempotent and safe to retry. Source: Finnhub. Returns up to 5 recent articles with headline, summary, source, and date.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: {
          type: 'string',
          description: 'Stock ticker symbol (e.g. "AAPL", "MSFT", "TSLA")'
        },
        daysBack: {
          type: 'number',
          description:
            'How many days of news to fetch (default: 7, max: 30)'
        }
      },
      required: ['symbol']
    }
  };

  protected async run(
    input: Record<string, unknown>,
    _context: ToolContext
  ): Promise<MarketNewsResult> {
    const symbol = String(input.symbol ?? '').trim().toUpperCase();
    const daysBack = Math.min(Math.max(0, Number(input.daysBack ?? 7)), 30);
    const now = formatDate(new Date());

    if (!symbol) {
      return {
        symbol: '',
        articles: [],
        asOf: now,
        source: 'Finnhub',
        reasonIfUnavailable: 'Symbol is required'
      };
    }

    if (!agentConfig.finnhubApiKey) {
      return {
        symbol,
        articles: [],
        asOf: now,
        source: 'Finnhub',
        reasonIfUnavailable: 'News data is not configured (missing FINNHUB_API_KEY)'
      };
    }

    try {
      const articles = await fetchFinnhubNews(symbol, daysBack);
      return {
        symbol,
        articles,
        asOf: now,
        source: 'Finnhub',
        reasonIfUnavailable: articles.length === 0 ? `No recent news found for ${symbol}` : null
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        symbol,
        articles: [],
        asOf: now,
        source: 'Finnhub',
        reasonIfUnavailable: `News fetch failed: ${msg}`
      };
    }
  }
}
