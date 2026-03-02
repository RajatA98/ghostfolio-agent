import Big from 'big.js';

import {
  AllocationRow,
  HoldingRow,
  Money,
  PortfolioSnapshotResult,
  ValuationMethod
} from '../agent.types';
import { ghostfolioGet } from './http';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

interface PortfolioPositionLike {
  symbol: string;
  name?: string;
  quantity: number;
  investment?: number;
  marketPrice?: number;
  valueInBaseCurrency?: number;
  currency?: string;
  assetClass?: string;
}

interface PortfolioDetailsLike {
  holdings: Record<string, PortfolioPositionLike>;
  hasErrors?: boolean;
}

const snapshotCache = new Map<string, { data: PortfolioSnapshotResult; ts: number }>();
const SNAPSHOT_CACHE_TTL_MS = 60_000; // 60 seconds — covers entire request lifecycle

export class GetPortfolioSnapshotTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioSnapshot',
    description:
      'Retrieves one portfolio snapshot: holdings, allocations, and total value for a time range. Single responsibility. Idempotent and safe to retry. Returns structured result; on API failure returns minimal snapshot with reasonIfUnavailable set.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dateRange: {
          type: 'string',
          enum: ['1d', 'wtd', 'mtd', 'ytd', '1y', '5y', 'max'],
          description:
            "Time range for the snapshot. Use 'mtd' for month-to-date (approximately last 30 days), 'ytd' for year-to-date, '1y' for one year, 'max' for all time. Defaults to 'max'."
        }
      },
      required: []
    }
  };

  protected async run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PortfolioSnapshotResult> {
    const dateRange = String(input.dateRange ?? 'max');

    // Check in-memory cache (avoids redundant Ghostfolio API calls across iterations)
    const cacheKey = `${context.userId}:${dateRange}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SNAPSHOT_CACHE_TTL_MS) {
      return cached.data;
    }

    const result = await ghostfolioGet<PortfolioDetailsLike>({
      path: `/api/v1/portfolio/details?range=${encodeURIComponent(dateRange)}`,
      jwt: context.jwt
    });
    const snapshot = this.mapToSnapshot(result, context.baseCurrency);

    snapshotCache.set(cacheKey, { data: snapshot, ts: Date.now() });
    return snapshot;
  }

  protected onError(
    error: unknown,
    _input: Record<string, unknown>,
    context: ToolContext
  ): PortfolioSnapshotResult {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString().split('T')[0];
    return this.emptySnapshot(context.baseCurrency, now, message);
  }

  private emptySnapshot(
    baseCurrency: string,
    now: string,
    reasonIfUnavailable: string
  ): PortfolioSnapshotResult {
    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod: 'cost_basis',
      asOf: null,
      totalValue: { currency: baseCurrency, amount: 0 },
      allocationBySymbol: [],
      allocationByAssetClass: [],
      holdings: [],
      isPriceDataMissing: true,
      reasonIfUnavailable
    };
  }

  private mapToSnapshot(
    details: PortfolioDetailsLike,
    baseCurrency: string
  ): PortfolioSnapshotResult {
    const positions = Object.values(details.holdings ?? {});
    let isPriceDataMissing = false;

    const holdings: HoldingRow[] = positions
      .filter(
        (pos: PortfolioPositionLike) =>
          pos.quantity > 0 || (pos.valueInBaseCurrency ?? 0) > 0
      )
      .map((pos: PortfolioPositionLike) => {
        const hasMissingPrice =
          pos.marketPrice === 0 ||
          pos.marketPrice == null ||
          pos.valueInBaseCurrency === 0 ||
          pos.valueInBaseCurrency == null;

        if (hasMissingPrice) {
          isPriceDataMissing = true;
        }

        return {
          symbol: pos.symbol,
          name: pos.name ?? null,
          quantity: pos.quantity,
          costBasis: pos.investment
            ? ({ currency: baseCurrency, amount: pos.investment } as Money)
            : null,
          price: pos.marketPrice
            ? ({
                currency: pos.currency ?? baseCurrency,
                amount: pos.marketPrice
              } as Money)
            : null,
          value: pos.valueInBaseCurrency
            ? ({
                currency: baseCurrency,
                amount: pos.valueInBaseCurrency
              } as Money)
            : null,
          assetClass: pos.assetClass ?? null
        };
      });

    const totalValue = holdings.reduce((sum, h) => {
      return sum.plus(new Big(h.value?.amount ?? h.costBasis?.amount ?? 0));
    }, new Big(0));

    const allocationBySymbol: AllocationRow[] = holdings.map((h) => {
      const holdingValue = new Big(
        h.value?.amount ?? h.costBasis?.amount ?? 0
      );
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
      const val = new Big(h.value?.amount ?? h.costBasis?.amount ?? 0);
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

    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: valuationMethod === 'market' ? now : null,
      totalValue: {
        currency: baseCurrency,
        amount: totalValue.toNumber()
      },
      allocationBySymbol,
      allocationByAssetClass,
      holdings,
      isPriceDataMissing
    };
  }
}
