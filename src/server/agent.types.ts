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
  terminationReason:
    | 'end_turn'
    | 'max_iterations'
    | 'timeout'
    | 'cost_limit'
    | 'circuit_breaker'
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

// --- Brokerage ---

export interface BrokerageHolding {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: number | null;
  currentValue: number | null;
  currency: string;
  institutionName: string;
}

export interface BrokerageService {
  getHoldings(userId: string, supabaseUserId: string): Promise<{ holdings: BrokerageHolding[] }>;
}

export interface ConnectBrokerageResult {
  redirectURI: string;
}
