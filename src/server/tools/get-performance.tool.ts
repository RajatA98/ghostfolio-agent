import { PerformancePoint, PerformanceResult, ValuationMethod } from '../agent.types';
import { ghostfolioGet } from './http';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

const MAX_CHART_POINTS = 20;

interface HistoricalDataItemLike {
  date: string;
  netWorth?: number;
  netPerformanceInPercentage?: number;
}

interface PortfolioPerformanceLike {
  chart?: HistoricalDataItemLike[];
  hasErrors?: boolean;
  performance?: {
    netPerformancePercentage?: number;
  };
}

export class GetPerformanceTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPerformance',
    description:
      'Retrieves portfolio performance for one time range only: total return percentage and time series. Single responsibility. Idempotent and safe to retry. Returns structured result; on failure sets reasonIfUnavailable.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dateRange: {
          type: 'string',
          enum: ['1d', 'wtd', 'mtd', 'ytd', '1y', '5y', 'max'],
          description:
            "Time range for performance data. Use 'mtd' for month-to-date (approximately last 30 days), 'ytd' for year-to-date, '1y' for one year, 'max' for all time."
        }
      },
      required: ['dateRange']
    }
  };

  protected async run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PerformanceResult> {
    const dateRange = String(input.dateRange ?? 'max');
    const result = await ghostfolioGet<PortfolioPerformanceLike>({
      path: `/api/v2/portfolio/performance?range=${encodeURIComponent(dateRange)}`,
      jwt: context.jwt
    });

    const chart = result.chart ?? [];
    const sampledChart = this.sampleChart(chart, MAX_CHART_POINTS);

    const timeSeries: PerformancePoint[] = sampledChart.map((item) => ({
      date: item.date,
      value: {
        currency: context.baseCurrency,
        amount: item.netWorth ?? 0
      },
      returnPercent: item.netPerformanceInPercentage ?? null
    }));

    const totalReturnPercent = result.performance?.netPerformancePercentage ?? null;

    const valuationMethod: ValuationMethod = result.hasErrors
      ? 'cost_basis'
      : 'market';

    const now = new Date().toISOString().split('T')[0];

    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: now,
      totalReturnPercent,
      timeSeries,
      reasonIfUnavailable: result.hasErrors
        ? 'Some data may be incomplete or contain errors.'
        : null
    };
  }

  protected onError(
    error: unknown,
    _input: Record<string, unknown>,
    _context: ToolContext
  ): PerformanceResult {
    const now = new Date().toISOString().split('T')[0];
    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod: 'cost_basis',
      asOf: null,
      totalReturnPercent: null,
      timeSeries: [],
      reasonIfUnavailable: `Performance data is not available: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }

  private sampleChart(
    chart: HistoricalDataItemLike[],
    maxPoints: number
  ): HistoricalDataItemLike[] {
    if (chart.length <= maxPoints) {
      return chart;
    }

    const step = Math.ceil(chart.length / maxPoints);
    const sampled = chart.filter((_, i) => i % step === 0);

    if (
      chart.length > 0 &&
      sampled[sampled.length - 1] !== chart[chart.length - 1]
    ) {
      sampled.push(chart[chart.length - 1]);
    }

    return sampled;
  }
}
