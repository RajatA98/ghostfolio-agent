import { GhostfolioPortfolioService } from '../services/ghostfolio-portfolio.service';
import { PortfolioReadResult } from '../agent.types';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class PortfolioReadTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'getPortfolioData',
    description:
      "Reads the user's full portfolio from Ghostfolio including all holdings, market values, and allocation percentages. Use this to answer questions about what the user owns, their portfolio value, and allocation breakdown.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  };

  constructor(private readonly portfolioService: GhostfolioPortfolioService) {}

  public async execute(
    _input: Record<string, unknown>,
    context: ToolContext
  ): Promise<PortfolioReadResult> {
    return this.portfolioService.getPortfolioData(context.jwt);
  }
}
