import Big from 'big.js';

import {
  AllocationRow,
  HoldingRow,
  Money,
  PerformanceResult,
  PortfolioSnapshotResult,
  ValuationMethod
} from '../agent.types';
import { fetchYahooQuote, toYahooSymbol } from '../lib/yahoo';
import { BrokerageService } from '../agent.types';

interface CachedSnapshot {
  data: PortfolioSnapshotResult;
  ts: number;
}

export class PortfolioService {
  private cache = new Map<string, CachedSnapshot>();
  private static readonly CACHE_TTL_MS = 60_000; // 60s

  constructor(private readonly brokerageService: BrokerageService) {}

  async getSnapshot(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string
  ): Promise<PortfolioSnapshotResult> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.ts < PortfolioService.CACHE_TTL_MS) {
      return cached.data;
    }

    const { holdings: brokerageHoldings } =
      await this.brokerageService.getHoldings(userId, supabaseUserId ?? userId);

    let isPriceDataMissing = false;
    const holdings: HoldingRow[] = [];

    for (const h of brokerageHoldings) {
      const yahooSymbol = toYahooSymbol(h.symbol);
      const quote = fetchYahooQuote(yahooSymbol);

      let price: Money | null = null;
      let value: Money | null = null;

      if (quote) {
        price = { currency: quote.currency, amount: quote.price };
        value = { currency: quote.currency, amount: quote.price * h.quantity };
      } else if (h.currentValue != null && h.quantity > 0) {
        // Fall back to brokerage institution-provided value
        const unitPrice = h.currentValue / h.quantity;
        price = { currency: h.currency, amount: unitPrice };
        value = { currency: h.currency, amount: h.currentValue };
      } else if (h.costBasis != null && h.quantity > 0) {
        // Last resort: cost basis
        isPriceDataMissing = true;
        const unitPrice = h.costBasis / h.quantity;
        price = { currency: h.currency, amount: unitPrice };
        value = { currency: h.currency, amount: h.costBasis };
      } else {
        isPriceDataMissing = true;
      }

      holdings.push({
        symbol: h.symbol,
        name: h.name,
        quantity: h.quantity,
        costBasis: h.costBasis != null
          ? { currency: h.currency, amount: h.costBasis }
          : null,
        price,
        value,
        assetClass: this.classifyAsset(h.symbol)
      });
    }

    const totalValue = holdings.reduce(
      (sum, h) => sum.plus(new Big(h.value?.amount ?? 0)),
      new Big(0)
    );

    const allocationBySymbol: AllocationRow[] = holdings.map((h) => {
      const holdingValue = new Big(h.value?.amount ?? 0);
      const percent = totalValue.gt(0)
        ? holdingValue.div(totalValue).times(100).toNumber()
        : 0;
      return {
        key: h.symbol,
        value: { currency: baseCurrency, amount: holdingValue.toNumber() },
        percent: Math.round(percent * 100) / 100
      };
    });

    const assetClassMap = new Map<string, Big>();
    for (const h of holdings) {
      const cls = h.assetClass ?? 'UNKNOWN';
      const val = new Big(h.value?.amount ?? 0);
      assetClassMap.set(cls, (assetClassMap.get(cls) ?? new Big(0)).plus(val));
    }

    const allocationByAssetClass: AllocationRow[] = Array.from(
      assetClassMap.entries()
    ).map(([key, val]) => ({
      key,
      value: { currency: baseCurrency, amount: val.toNumber() },
      percent: totalValue.gt(0)
        ? Math.round(val.div(totalValue).times(100).toNumber() * 100) / 100
        : 0
    }));

    const valuationMethod: ValuationMethod = isPriceDataMissing
      ? 'cost_basis'
      : 'market';
    const now = new Date().toISOString().split('T')[0];

    const result: PortfolioSnapshotResult = {
      accountId: 'snaptrade',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: valuationMethod === 'market' ? now : null,
      totalValue: { currency: baseCurrency, amount: totalValue.toNumber() },
      allocationBySymbol,
      allocationByAssetClass,
      holdings,
      isPriceDataMissing
    };

    this.cache.set(userId, { data: result, ts: Date.now() });
    return result;
  }

  async getPerformance(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string
  ): Promise<PerformanceResult> {
    const snapshot = await this.getSnapshot(userId, baseCurrency, supabaseUserId);
    const now = new Date().toISOString().split('T')[0];

    let totalCostBasis = new Big(0);
    let totalCurrentValue = new Big(0);

    for (const h of snapshot.holdings) {
      totalCostBasis = totalCostBasis.plus(
        new Big(h.costBasis?.amount ?? h.value?.amount ?? 0)
      );
      totalCurrentValue = totalCurrentValue.plus(
        new Big(h.value?.amount ?? 0)
      );
    }

    const totalReturnPercent = totalCostBasis.gt(0)
      ? totalCurrentValue
          .minus(totalCostBasis)
          .div(totalCostBasis)
          .times(100)
          .toNumber()
      : null;

    return {
      accountId: 'snaptrade',
      timeframe: { start: '', end: now },
      valuationMethod: snapshot.valuationMethod,
      asOf: now,
      totalReturnPercent:
        totalReturnPercent != null
          ? Math.round(totalReturnPercent * 100) / 100
          : null,
      timeSeries: [],
      reasonIfUnavailable:
        'Historical time series is not available from brokerage data. Showing point-in-time gain/loss from cost basis vs current market value.'
    };
  }

  invalidateCache(userId: string): void {
    this.cache.delete(userId);
  }

  private classifyAsset(symbol: string): string {
    const upper = symbol.toUpperCase();
    const cryptoSymbols = new Set([
      'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT',
      'MATIC', 'LINK', 'UNI', 'LTC', 'BCH', 'ATOM', 'XLM', 'VET',
      'FIL', 'TRX', 'ETC', 'XMR', 'NEAR', 'APT', 'ARB', 'OP',
      'INJ', 'SUI', 'SEI', 'TIA', 'PEPE', 'SHIB'
    ]);
    if (cryptoSymbols.has(upper)) return 'CRYPTO';
    return 'EQUITY';
  }
}
