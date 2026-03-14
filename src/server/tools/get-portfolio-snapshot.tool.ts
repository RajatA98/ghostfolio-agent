import { PortfolioSnapshotResult } from '../agent.types';
import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class GetPortfolioSnapshotTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioSnapshot',
    description:
      'Retrieves the current portfolio holdings with allocations, values, and performance metrics. Use this tool to answer questions about portfolio composition, allocation breakdown, total value, and individual holding details.',
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

  constructor(private readonly portfolioService: PortfolioService) {}

  public async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PortfolioSnapshotResult> {
    return this.portfolioService.getSnapshot(context.userId, context.baseCurrency, context.supabaseUserId);
  }
}
