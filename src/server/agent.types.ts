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
}

// --- Plaid ---

export interface PlaidHolding {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: Money | null;
  currentValue: Money | null;
  institutionName: string;
}

export interface PlaidHoldingsResult {
  holdings: PlaidHolding[];
  institution: string;
  lastSynced: IsoDate;
}

export interface ConnectBrokerageResult {
  linkToken: string;
  expiration: string;
}

export interface SyncToGhostfolioResult {
  activitiesCreated: number;
  errors: string[];
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
}

export interface PortfolioReadResult {
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
