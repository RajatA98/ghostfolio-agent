/**
 * ## Tool Base Class Rules
 *
 * Every tool MUST:
 * 1. Do ONE thing (atomic) — single responsibility
 * 2. Be safe to retry (idempotent) where possible — read tools always;
 *    write tools document exceptions (e.g. logPaperTrade is not idempotent)
 * 3. Have clear documentation — description explains what it does, input_schema is complete
 * 4. Return structured results — typed return, never raw strings or untyped objects
 * 5. Handle errors gracefully — catch exceptions, return structured error (never throw from execute)
 */
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export abstract class BaseTool implements ToolExecutor {
  /** Every subclass must expose a static DEFINITION for the registry. */
  static readonly DEFINITION: AgentToolDefinition;

  /**
   * Public entry point called by the agent loop.
   * Wraps run() with try/catch so tools NEVER throw — errors are
   * returned as structured results via onError().
   *
   * Subclasses implement run(), NOT execute().
   */
  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown> {
    try {
      return await this.run(input, context);
    } catch (error) {
      return this.onError(error, input, context);
    }
  }

  /**
   * Core tool logic — implement in subclass.
   * May throw freely; BaseTool.execute() catches and delegates to onError().
   */
  protected abstract run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<unknown>;

  /**
   * Default error handler — returns a generic { error, reasonIfUnavailable } object.
   * Override in subclass for tool-specific error shapes (e.g. PaperTradeResult).
   */
  protected onError(
    error: unknown,
    _input: Record<string, unknown>,
    _context: ToolContext
  ): unknown {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, reasonIfUnavailable: message };
  }
}
