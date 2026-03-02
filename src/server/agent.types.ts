export type IsoDate = string;

export interface Timeframe {
  start: IsoDate;
  end: IsoDate;
}

export type ValuationMethod = 'market' | 'cost_basis';

export interface Money {
  currency: 'USD' | 'EUR' | string;
  amount: number;
}

export interface HoldingRow {
  symbol: string;
  name?: string | null;
  quantity: number;
  costBasis?: Money | null;
  price?: Money | null;
  value?: Money | null;
  assetClass?: string | null;
}

export interface AllocationRow {
  key: string;
  value: Money;
  percent: number;
}

export interface PortfolioSnapshotResult {
  accountId: string;
  timeframe: Timeframe;
  valuationMethod: ValuationMethod;
  asOf: IsoDate | null;
  totalValue: Money;
  allocationBySymbol: AllocationRow[];
  allocationByAssetClass?: AllocationRow[];
  holdings: HoldingRow[];
  isPriceDataMissing: boolean;
  /** Set when the snapshot could not be fully loaded (e.g. API error). */
  reasonIfUnavailable?: string | null;
}

export interface PerformancePoint {
  date: IsoDate;
  value: Money;
  returnPercent?: number | null;
}

export interface PerformanceResult {
  accountId: string;
  timeframe: Timeframe;
  valuationMethod: ValuationMethod;
  asOf: IsoDate | null;
  totalReturnPercent: number | null;
  timeSeries?: PerformancePoint[];
  reasonIfUnavailable?: string | null;
}

export type AllocationChange =
  | { type: 'buy'; symbol: string; amount: Money }
  | { type: 'sell'; symbol: string; amount: Money };

export interface SimulateAllocationResult {
  accountId: string;
  timeframe: Timeframe;
  valuationMethod: ValuationMethod;
  asOf: IsoDate | null;
  originalTotalValue: Money;
  newTotalValue: Money;
  newAllocationBySymbol: AllocationRow[];
  notes: string[];
  /** Set when the simulation could not run (e.g. portfolio fetch failed). */
  reasonIfUnavailable?: string | null;
}

export interface MarketPriceRow {
  symbol: string;
  price: Money;
  asOf: IsoDate;
  source: string;
}

export interface MarketPricesResult {
  rows: MarketPriceRow[];
  asOf: IsoDate;
  source: string;
}

export interface ToolTraceRow {
  tool: string;
  ok: boolean;
  ms: number;
  error?: string | null;
}

export interface AgentChatRequest {
  message: string;
  accountId?: string;
  timeframe?: Timeframe;
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
  mode?: 'analysis' | 'education';
  baseCurrency?: string;
  language?: string;
  userId?: string;
}

/** Tracks token usage across all iterations of a single agent request. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Metadata about the agent loop execution. */
export interface AgentLoopMeta {
  iterations: number;
  totalMs: number;
  tokenUsage: TokenUsage;
  estimatedCostUsd: number;
  toolsCalled: string[];
  terminationReason:
    | 'end_turn'
    | 'max_iterations'
    | 'timeout'
    | 'cost_limit'
    | 'circuit_breaker'
    | 'trade_blocked'
    | 'error';
}

export interface AgentChatResponse {
  answer: string;
  data: {
    valuationMethod: ValuationMethod;
    asOf: IsoDate | null;
    totalValue?: Money;
    allocationBySymbol?: AllocationRow[];
    allocationByAssetClass?: AllocationRow[];
  };
  toolTrace: ToolTraceRow[];
  confidence: number;
  warnings: string[];
  loopMeta?: AgentLoopMeta;
}

export type AgentStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'thinking'; iteration: number }
  | { type: 'tool_start'; tool: string; iteration: number }
  | {
      type: 'tool_end';
      tool: string;
      ok: boolean;
      ms: number;
      iteration: number;
      detail?: string;
    }
  | { type: 'text_delta'; text: string }
  | {
      type: 'done';
      answer: string;
      confidence: number;
      warnings: string[];
      toolTrace: ToolTraceRow[];
      loopMeta?: AgentLoopMeta;
      data?: AgentChatResponse['data'];
    }
  | { type: 'error'; message: string };

export interface GhostfolioActivity {
  accountId: string;
  currency: string;
  dataSource: 'YAHOO' | 'MANUAL';
  date: string;
  fee: number;
  quantity: number;
  symbol: string;
  type: 'BUY' | 'SELL' | 'DEPOSIT' | 'WITHDRAWAL';
  unitPrice: number;
}

// --- Fund Movements (Deposits & Withdrawals via Ghostfolio) ---

export interface FundMovementResult {
  movementId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  currency: string;
  status: string;
  ghostfolioSynced: boolean;
  /** Set when the fund movement could not be logged (e.g. network or API error). */
  error?: string | null;
}

// --- Paper Trading (via Ghostfolio) ---

export interface PaperTradeInput {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  unitPrice: number;
  currency?: string;
}

export interface PaperTradeResult {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  unitPrice: number;
  currency: string;
  status: string;
  ghostfolioSynced: boolean;
  /** Set when the trade could not be logged (e.g. network or API error). */
  error?: string | null;
}

// --- Stock Overview (Yahoo Finance fundamentals) ---

export interface StockOverviewRow {
  symbol: string;
  price: Money;
  previousClose: number;
  dayChangePercent: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  marketCap: number | null;
  avgVolume: number | null;
  exchange: string | null;
  assetType: string | null;
  asOf: IsoDate;
  source: string;
}

export interface StockOverviewResult {
  rows: StockOverviewRow[];
  asOf: IsoDate;
  source: string;
}

// --- Market News (Finnhub) ---

export interface NewsArticle {
  headline: string;
  summary: string;
  source: string;
  datetime: IsoDate;
  url: string;
}

export interface MarketNewsResult {
  symbol: string;
  articles: NewsArticle[];
  asOf: IsoDate;
  source: string;
  /** Set when news could not be fetched (e.g. missing API key or network error). */
  reasonIfUnavailable?: string | null;
}

// --- Portfolio Read ---

export interface PortfolioReadResult {
  /** Set when the request failed (e.g. auth or API error). When set, holdings may be empty. */
  error?: string | null;
  holdings: Array<{
    symbol: string;
    name?: string | null;
    quantity: number;
    marketPrice: number;
    marketValue: number;
    currency: string;
    allocationPercent: number;
  }>;
  totalValue: Money;
  asOf: IsoDate;
}
