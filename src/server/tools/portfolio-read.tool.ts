import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PortfolioReadTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioData',
    description:
      "Gets the user's portfolio data from their connected brokerage. Use for any question about their holdings, performance, returns, or net worth.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['holdings', 'performance'],
          description:
            'The type of portfolio data to retrieve. Defaults to holdings.'
        }
      },
      required: []
    }
  };

  constructor(private readonly portfolioService: PortfolioService) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown> {
    const dataType = String(input.type ?? 'holdings');

    switch (dataType) {
      case 'performance':
        return this.portfolioService.getPerformance(
          context.userId,
          context.baseCurrency,
          context.supabaseUserId
        );
      case 'holdings':
      default:
        return this.portfolioService.getSnapshot(
          context.userId,
          context.baseCurrency,
          context.supabaseUserId
        );
    }
  }
}
