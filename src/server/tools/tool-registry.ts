export interface ToolContext {
  userId: string;
  baseCurrency: string;
  impersonationId?: string;
  jwt: string;
}

export interface ToolExecutor {
  execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown>;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RegisteredTool {
  definition: AgentToolDefinition;
  executor: ToolExecutor;
  enabled: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  public register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  public getDefinitions(): AgentToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((t) => t.enabled)
      .map((t) => t.definition);
  }

  public getExecutor(name: string): ToolExecutor | undefined {
    const tool = this.tools.get(name);

    if (tool && !tool.enabled) {
      return undefined;
    }

    return tool?.executor;
  }
}
