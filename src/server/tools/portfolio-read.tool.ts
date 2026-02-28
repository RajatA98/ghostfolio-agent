import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { PortfolioReadResult } from '../agent.types';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

export class PortfolioReadTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioData',
    description:
      "Returns one kind of portfolio data: holdings, performance, summary, or activities (choose via type). Idempotent and safe to retry. Returns structured result; on failure returns empty/minimal data with error field set.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['holdings', 'performance', 'summary', 'activities'],
          description:
            'Which data to retrieve: holdings (default), performance, summary, or activities.'
        }
      },
      required: []
    }
  };

  constructor(private readonly portfolioService: GhostfolioPortfolioService) {
    super();
  }

  protected async run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown> {
    const dataType = String(input.type ?? 'holdings');

    switch (dataType) {
      case 'performance':
        return await this.portfolioService.getPerformance(context.userId, context.jwt);
      case 'summary':
        return await this.portfolioService.getSummary(context.userId, context.jwt);
      case 'activities':
        return await this.portfolioService.getActivities(context.userId, undefined, context.jwt);
      case 'holdings':
      default: {
        const result = await this.portfolioService.getPortfolioData(context.userId, context.jwt);
        return result as PortfolioReadResult;
      }
    }
  }

  protected onError(
    error: unknown,
    input: Record<string, unknown>,
    context: ToolContext
  ): unknown {
    const message = error instanceof Error ? error.message : String(error);
    const dataType = String(input.type ?? 'holdings');
    if (dataType === 'holdings') {
      const empty: PortfolioReadResult = {
        error: message,
        holdings: [],
        totalValue: { currency: context.baseCurrency, amount: 0 },
        asOf: new Date().toISOString().split('T')[0]
      };
      return empty;
    }
    return { error: message };
  }
}
