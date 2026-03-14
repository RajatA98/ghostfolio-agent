import { PerformanceResult } from '../agent.types';
import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetPerformanceTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPerformance',
    description:
      'Retrieves portfolio performance metrics showing gain/loss from cost basis vs current market value. Returns total return percentage. Note: historical time series is not available from brokerage data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dateRange: {
          type: 'string',
          enum: ['1d', 'wtd', 'mtd', 'ytd', '1y', '5y', 'max'],
          description:
            "Time range for performance data. Note: only point-in-time gain/loss is available (no historical time series)."
        }
      },
      required: ['dateRange']
    }
  };

  constructor(private readonly portfolioService: PortfolioService) {}

  public async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PerformanceResult> {
    return this.portfolioService.getPerformance(context.userId, context.baseCurrency, context.supabaseUserId);
  }
}
