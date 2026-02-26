import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PortfolioReadTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioData',
    description:
      "Gets the user's portfolio from Ghostfolio. Use for any question about their holdings, performance, returns, net worth, or trade history.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['holdings', 'performance', 'summary', 'activities'],
          description:
            'The type of portfolio data to retrieve. Defaults to holdings.'
        }
      },
      required: []
    }
  };

  constructor(private readonly portfolioService: GhostfolioPortfolioService) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown> {
    const dataType = String(input.type ?? 'holdings');

    switch (dataType) {
      case 'performance':
        return this.portfolioService.getPerformance(context.userId);
      case 'summary':
        return this.portfolioService.getSummary(context.userId);
      case 'activities':
        return this.portfolioService.getActivities(context.userId);
      case 'holdings':
      default:
        return this.portfolioService.getPortfolioData(context.userId);
    }
  }
}
