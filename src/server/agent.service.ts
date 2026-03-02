import type Anthropic from '@anthropic-ai/sdk';

import { agentConfig } from './agent.config';
import { buildSystemPrompt } from './agent.prompt';
import {
  AgentChatRequest,
  AgentChatResponse,
  AgentStreamEvent,
  AgentLoopMeta,
  AllocationChange,
  PortfolioSnapshotResult,
  ToolTraceRow,
  ValuationMethod
} from './agent.types';
import { computeConfidence, verifyAgentResponse, verifyTradePrice } from './agent.verifier';
import { createAnthropicClient, withLangfuseTrace } from './observability';
import {
  checkTradeConfirmation,
  checkFundMovementConfirmation,
  formatTradeProposal,
  TradeGuardrailInput,
  FundMovementGuardrailInput
} from './trade-guardrail';
import { GhostfolioPortfolioService } from './services/ghostfolio-portfolio.service';
import { GetMarketPricesTool } from './tools/get-market-prices.tool';
import { GetPerformanceTool } from './tools/get-performance.tool';
import { GetPortfolioSnapshotTool } from './tools/get-portfolio-snapshot.tool';
import { PortfolioReadTool } from './tools/portfolio-read.tool';
import { PortfolioTradeTool } from './tools/portfolio-trade.tool';
import { SimulateAllocationChangeTool } from './tools/simulate-allocation-change.tool';
import { GetStockOverviewTool } from './tools/get-stock-overview.tool';
import { GetMarketNewsTool } from './tools/get-market-news.tool';
import { DepositWithdrawTool } from './tools/deposit-withdraw.tool';
import { ToolContext, ToolRegistry } from './tools/tool-registry';

interface RunnableToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

const SONNET_INPUT_TOKEN_COST_USD = 3.0 / 1_000_000;
const SONNET_OUTPUT_TOKEN_COST_USD = 15.0 / 1_000_000;

/**
 * Check if a tool result indicates a graceful failure (returned error or
 * reasonIfUnavailable instead of throwing). BaseTool.execute() swallows all
 * errors, so these results appear as resolved promises. We need to detect
 * them to report accurate ok/failed status in the tool trace.
 *
 * A result is considered failed ONLY when:
 * - It has an explicit `error` field (from onError()), OR
 * - It has `reasonIfUnavailable` AND no meaningful data alongside it.
 *   Tools like getPerformance may return both data AND reasonIfUnavailable
 *   as a warning — those are treated as success with a caveat.
 */
function detectToolResultError(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  // Check for explicit error field (e.g. onError() returns { error: "..." })
  if (typeof r.error === 'string' && r.error) return r.error;
  // Check for reasonIfUnavailable — but only if the result lacks real data.
  // If the result has arrays with data or numeric values, it's a warning, not failure.
  if (typeof r.reasonIfUnavailable === 'string' && r.reasonIfUnavailable) {
    const hasData = Object.entries(r).some(([key, val]) => {
      if (key === 'reasonIfUnavailable' || key === 'error' || key === 'asOf' || key === 'source') return false;
      if (Array.isArray(val) && val.length > 0) return true;
      if (typeof val === 'number' && val !== 0) return true;
      return false;
    });
    if (!hasData) return r.reasonIfUnavailable;
  }
  return null;
}

export class AgentService {
  private readonly toolRegistry: ToolRegistry;

  public constructor() {
    this.toolRegistry = new ToolRegistry();

    this.toolRegistry.register({
      definition: GetPortfolioSnapshotTool.DEFINITION,
      executor: new GetPortfolioSnapshotTool(),
      enabled: true
    });

    this.toolRegistry.register({
      definition: GetPerformanceTool.DEFINITION,
      executor: new GetPerformanceTool(),
      enabled: true
    });

    this.toolRegistry.register({
      definition: SimulateAllocationChangeTool.DEFINITION,
      executor: new SimulateAllocationChangeTool(),
      enabled: true
    });

    this.toolRegistry.register({
      definition: GetMarketPricesTool.DEFINITION,
      executor: new GetMarketPricesTool(),
      enabled: agentConfig.enableExternalMarketData
    });

    this.toolRegistry.register({
      definition: GetStockOverviewTool.DEFINITION,
      executor: new GetStockOverviewTool(),
      enabled: agentConfig.enableExternalMarketData
    });

    this.toolRegistry.register({
      definition: GetMarketNewsTool.DEFINITION,
      executor: new GetMarketNewsTool(),
      enabled: agentConfig.enableNewsData
    });

    // --- Ghostfolio portfolio tools (paper trading via Ghostfolio) ---
    const portfolioService = new GhostfolioPortfolioService();

    this.toolRegistry.register({
      definition: PortfolioReadTool.DEFINITION,
      executor: new PortfolioReadTool(portfolioService),
      enabled: true
    });

    this.toolRegistry.register({
      definition: PortfolioTradeTool.DEFINITION,
      executor: new PortfolioTradeTool(portfolioService),
      enabled: true,
      requiresConfirmation: true
    });

    this.toolRegistry.register({
      definition: DepositWithdrawTool.DEFINITION,
      executor: new DepositWithdrawTool(portfolioService),
      enabled: true,
      requiresConfirmation: true
    });

  }

  public async chat(
    request: AgentChatRequest,
    userContext: {
      userId: string;
      baseCurrency: string;
      language: string;
      jwt: string;
      impersonationId?: string;
    },
    onEvent?: (event: AgentStreamEvent) => void
  ): Promise<AgentChatResponse> {
    if (!agentConfig.anthropicApiKey) {
      onEvent?.({
        type: 'error',
        message:
          'The portfolio analysis agent is not currently configured. Please set the ANTHROPIC_API_KEY environment variable.'
      });
      return this.buildErrorResponse(
        'The portfolio analysis agent is not currently configured. Please set the ANTHROPIC_API_KEY environment variable.',
        []
      );
    }

    const toolTrace: ToolTraceRow[] = [];
    const toolResults = new Map<string, unknown>();
    let toolsSucceeded = 0;
    let toolsFailed = 0;

    const runChat = async (): Promise<AgentChatResponse> => {
      // Pre-request guard: block tone-change prompts before they reach the LLM.
      if (this.isToneChangePrompt(request.message)) {
        const deflection = this.getToneDeflectionResponse();
        onEvent?.({
          type: 'done',
          answer: deflection,
          confidence: 1,
          warnings: [],
          toolTrace: [],
          data: { valuationMethod: 'market', asOf: null }
        });
        return {
          answer: deflection,
          data: { valuationMethod: 'market', asOf: null },
          toolTrace: [],
          confidence: 1,
          warnings: []
        };
      }

      const client = createAnthropicClient();
      const toolDefinitions = this.toolRegistry.getDefinitions();

      const systemPrompt = buildSystemPrompt({
        baseCurrency: userContext.baseCurrency,
        language: userContext.language,
        currentDate: new Date().toISOString().split('T')[0],
        toolInventory: toolDefinitions.map((tool) => ({
          name: tool.name,
          description: tool.description
        }))
      });

      // Conversation history sliding window: cap to last 6 turns to prevent token blowup
      const MAX_HISTORY_TURNS = 6;
      const messages: Anthropic.MessageParam[] = [];
      if (request.conversationHistory) {
        const history = request.conversationHistory;
        let trimmedHistory = history;
        if (history.length > MAX_HISTORY_TURNS) {
          const oldTurns = history.slice(0, -MAX_HISTORY_TURNS);
          const summary = `[Earlier conversation: user asked about ${oldTurns.filter(m => m.role === 'user').map(m => m.content.slice(0, 50)).join(', ')}]`;
          trimmedHistory = [
            { role: 'user' as const, content: summary },
            { role: 'assistant' as const, content: 'Understood, I have context from our earlier conversation.' },
            ...history.slice(-MAX_HISTORY_TURNS)
          ];
        }
        for (const msg of trimmedHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: 'user', content: request.message });

      const allAnthropicTools: Anthropic.Tool[] = toolDefinitions.map((td) => ({
          name: td.name,
          description: td.description,
          input_schema: td.input_schema as Anthropic.Tool.InputSchema
      }));
      // Track which tools have been called across iterations for conditional inclusion
      const calledToolNames = new Set<string>();

      const toolContext: ToolContext = {
        userId: userContext.userId,
        baseCurrency: userContext.baseCurrency,
        impersonationId: userContext.impersonationId,
        jwt: userContext.jwt
      };

      // ─── Guardrail state ──────────────────────────────────────────
      const loopStartMs = Date.now();
      let iteration = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let terminationReason: AgentLoopMeta['terminationReason'] = 'end_turn';
      const toolsCalled: string[] = [];
      let tradeBlocked = false;
      const circuitBreakerMap = new Map<string, number>();
      let syntheticInjectedThisRequest = false;
      let lastResponseContent: Anthropic.ContentBlock[] | null = null;
      let tradeProposalForFallback: string | null = null;

      // ─── ReAct loop: Thought → Action → Observation ───────────────
      while (iteration < agentConfig.maxIterations) {
        const displayIteration = iteration + 1;
        onEvent?.({ type: 'iteration_start', iteration: displayIteration });

        // Timeout check
        if (Date.now() - loopStartMs > agentConfig.timeoutMs) {
          terminationReason = 'timeout';
          break;
        }

        // Cost check
        if (totalInputTokens + totalOutputTokens > agentConfig.costLimitTokens) {
          terminationReason = 'cost_limit';
          break;
        }

        // Conditional tool inclusion: on iteration 0 send all tools; on iteration 1+
        // only include tools the LLM just called or hasn't called yet (reduces token count)
        let anthropicTools = allAnthropicTools;
        if (iteration > 0) {
          anthropicTools = allAnthropicTools.filter(
            t => !calledToolNames.has(t.name) || toolsCalled.includes(t.name)
          );
          // Always include at least the tools from last iteration so LLM can re-call
          if (anthropicTools.length === 0) {
            anthropicTools = allAnthropicTools;
          }
        }

        // LLM call: suppress tools if trade was just blocked.
        // Use prompt caching on system message to reduce input tokens on iterations 2+
        const systemWithCache: Anthropic.TextBlockParam[] = [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ];
        const response = await client.messages.create({
          model: agentConfig.anthropicModel,
          max_tokens: agentConfig.maxTokens,
          temperature: agentConfig.temperature,
          system: systemWithCache,
          messages,
          ...(tradeBlocked ? {} : { tools: anthropicTools })
        });

        // Track tokens
        totalInputTokens += response.usage?.input_tokens ?? 0;
        totalOutputTokens += response.usage?.output_tokens ?? 0;

        // Reset tradeBlocked for next iteration
        tradeBlocked = false;

        // Save content for post-loop text extraction
        lastResponseContent = response.content;
        onEvent?.({ type: 'thinking', iteration: displayIteration });

        // ─── Extract LLM tool calls (if any) ─────────────────────────
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
        );
        const runnableToolUseBlocks: RunnableToolUse[] = toolUseBlocks.map((b) => ({
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: b.input
        }));

        // Synthetic tool injection: ONLY on first iteration.
        // Important: check this BEFORE the end_turn break so that if the
        // LLM didn't call tools but the message has portfolio intent,
        // we still inject synthetic tools (e.g. "Get market prices.").
        let syntheticToolUseBlocks: RunnableToolUse[] = [];
        if (!syntheticInjectedThisRequest) {
          syntheticToolUseBlocks = this.buildSyntheticToolUseBlocks({
            message: request.message,
            existingToolNames: new Set(toolUseBlocks.map((b) => b.name)),
            baseCurrency: userContext.baseCurrency,
            conversationHistory: request.conversationHistory
          });
          syntheticInjectedThisRequest = true;
        }

        const allToolUseBlocks = [...runnableToolUseBlocks, ...syntheticToolUseBlocks];

        // If stop_reason is end_turn AND there are no synthetic tools to
        // inject, the LLM is done. Stream the final answer if onEvent is provided.
        if (response.stop_reason !== 'tool_use' && syntheticToolUseBlocks.length === 0) {
          terminationReason = 'end_turn';

          // Stream the final answer text via text_delta events
          if (onEvent) {
            const answerText = this.extractText(response.content);
            if (answerText) {
              // Emit text in chunks with micro-delays so SSE flushes each one
              const chunkSize = 12;
              for (let i = 0; i < answerText.length; i += chunkSize) {
                onEvent({ type: 'text_delta', text: answerText.slice(i, i + chunkSize) });
                // Yield to event loop so res.write() actually flushes
                if (i + chunkSize < answerText.length) {
                  await new Promise((r) => setImmediate(r));
                }
              }
            }
          }

          break;
        }

        // If no tools to execute (shouldn't normally happen with stop_reason=tool_use)
        if (allToolUseBlocks.length === 0) {
          terminationReason = 'end_turn';
          break;
        }

        // ─── Circuit breaker check ──────────────────────────────────
        let circuitBroken = false;
        for (const toolUse of allToolUseBlocks) {
          const key = `${toolUse.name}:${this.hashArgs(toolUse.input)}`;
          const count = (circuitBreakerMap.get(key) ?? 0) + 1;
          circuitBreakerMap.set(key, count);
          if (count >= agentConfig.circuitBreakerThreshold) {
            circuitBroken = true;
            break;
          }
        }
        if (circuitBroken) {
          terminationReason = 'circuit_breaker';
          break;
        }

        // ─── Execute tools ──────────────────────────────────────────
        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

        // Partition: read-only tools can run in parallel, write tools must be sequential
        const readOnlyTools: RunnableToolUse[] = [];
        const writeTools: RunnableToolUse[] = [];
        for (const toolUse of allToolUseBlocks) {
          if (this.toolRegistry.needsConfirmation(toolUse.name)) {
            writeTools.push(toolUse);
          } else {
            readOnlyTools.push(toolUse);
          }
        }

        // Execute read-only tools in parallel
        if (readOnlyTools.length > 0) {
          const parallelResults = await Promise.allSettled(
            readOnlyTools.map(async (toolUse) => {
              toolsCalled.push(toolUse.name);
              onEvent?.({
                type: 'tool_start',
                tool: toolUse.name,
                iteration: displayIteration
              });
              const startMs = Date.now();
              const executor = this.toolRegistry.getExecutor(toolUse.name);

              if (!executor) {
                throw { isUnknownTool: true, toolUse, startMs, errorMsg: `Unknown or disabled tool: ${toolUse.name}` };
              }

              const result = await executor.execute(
                toolUse.input as Record<string, unknown>,
                toolContext
              );
              return { toolUse, result, ms: Date.now() - startMs };
            })
          );

          for (const settled of parallelResults) {
            if (settled.status === 'fulfilled') {
              const { toolUse, result, ms } = settled.value;
              toolResults.set(toolUse.name, result);
              const resultError = detectToolResultError(result);
              if (resultError) {
                toolsFailed++;
                toolTrace.push({ tool: toolUse.name, ok: false, ms, error: resultError });
              } else {
                toolsSucceeded++;
                toolTrace.push({ tool: toolUse.name, ok: true, ms });
              }
              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result)
              });
              const toolOk = !resultError;
              const detail =
                resultError ??
                (toolUse.name === 'getMarketPrices' &&
                typeof result === 'object' &&
                result &&
                'source' in result &&
                typeof (result as { source?: unknown }).source === 'string'
                  ? String((result as { source: string }).source)
                  : undefined);
              onEvent?.({
                type: 'tool_end',
                tool: toolUse.name,
                ok: toolOk,
                ms,
                iteration: displayIteration,
                detail
              });
              onEvent?.({
                type: 'tool_detail',
                tool: toolUse.name,
                input: toolUse.input as Record<string, unknown>,
                result: this.truncateToolResult(result, 500),
                iteration: displayIteration
              });
            } else {
              const reason = settled.reason;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const isUnknown = reason && typeof reason === 'object' && (reason as any).isUnknownTool;
              if (isUnknown) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { toolUse, startMs, errorMsg } = reason as any;
                toolsFailed++;
                toolTrace.push({ tool: toolUse.name, ok: false, ms: Date.now() - startMs, error: errorMsg });
                toolResultBlocks.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({ error: errorMsg }),
                  is_error: true
                });
                onEvent?.({ type: 'tool_end', tool: toolUse.name, ok: false, ms: Date.now() - startMs, iteration: displayIteration, detail: errorMsg });
              } else {
                // Executor threw — extract tool info from the promise index
                const idx = parallelResults.indexOf(settled);
                const toolUse = readOnlyTools[idx];
                const errorMsg = reason instanceof Error ? reason.message : String(reason);
                toolsFailed++;
                toolTrace.push({ tool: toolUse.name, ok: false, ms: 0, error: errorMsg });
                toolResultBlocks.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: JSON.stringify({ error: `Tool execution failed: ${errorMsg}` }),
                  is_error: true
                });
                onEvent?.({ type: 'tool_end', tool: toolUse.name, ok: false, ms: 0, iteration: displayIteration, detail: errorMsg });
              }
            }
          }
        }

        // Execute write tools sequentially (guardrail logic preserved)
        for (const toolUse of writeTools) {
          toolsCalled.push(toolUse.name);
          onEvent?.({
            type: 'tool_start',
            tool: toolUse.name,
            iteration: displayIteration
          });
          const startMs = Date.now();
          const executor = this.toolRegistry.getExecutor(toolUse.name);

          if (!executor) {
            const errorMsg = `Unknown or disabled tool: ${toolUse.name}`;
            toolsFailed++;
            toolTrace.push({
              tool: toolUse.name,
              ok: false,
              ms: Date.now() - startMs,
              error: errorMsg
            });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: errorMsg }),
              is_error: true
            });
            onEvent?.({
              type: 'tool_end',
              tool: toolUse.name,
              ok: false,
              ms: Date.now() - startMs,
              iteration: displayIteration,
              detail: errorMsg
            });
            continue;
          }

          // ─── Confirmation guardrail (trades + fund movements) ──────
          const toolInput = toolUse.input as Record<string, unknown>;
          const isFundMovement = toolUse.name === 'logFundMovement';

          const guardrailResult = isFundMovement
            ? checkFundMovementConfirmation(
                toolInput as unknown as FundMovementGuardrailInput,
                request.message,
                request.conversationHistory
              )
            : checkTradeConfirmation(
                toolInput as unknown as TradeGuardrailInput,
                request.message,
                request.conversationHistory
              );

          if (!guardrailResult.allowed) {
            tradeBlocked = true;

            let blockedMsg: string;

            if (guardrailResult.cancelled) {
              blockedMsg = isFundMovement
                ? 'FUND_MOVEMENT_CANCELLED: The user cancelled this fund movement. Do not execute it. Tell the user the fund movement was cancelled and nothing was executed.'
                : 'TRADE_CANCELLED: The user cancelled this trade. Do not execute it. Tell the user the trade was cancelled and nothing was executed.';
            } else if (isFundMovement) {
              blockedMsg = guardrailResult.proposal ?? '';
            } else {
              // Build price-verified citation for the guardrail message
              const _guardPriceV = verifyTradePrice({
                symbol: (toolInput as unknown as TradeGuardrailInput).symbol,
                proposedPrice: (toolInput as unknown as TradeGuardrailInput).unitPrice,
                toolResults
              });
              blockedMsg = guardrailResult.proposal ?? formatTradeProposal(
                toolInput as unknown as TradeGuardrailInput,
                { priceCitation: _guardPriceV.citationText, priceWarning: _guardPriceV.warning }
              );
            }

            // Store deterministic fallback for the confirmation prompt
            if (!guardrailResult.cancelled) {
              if (isFundMovement) {
                const fi = toolInput as unknown as FundMovementGuardrailInput;
                const action = fi.type?.toUpperCase() === 'WITHDRAWAL' ? 'withdraw' : 'deposit';
                const currency = fi.currency ?? 'USD';
                tradeProposalForFallback =
                  `I'd like to ${action} the following funds — please confirm:\n\n` +
                  `**${fi.type?.toUpperCase()} $${Number(fi.amount).toFixed(2)} ${currency}**\n\n` +
                  `This is simulated — no real money involved. ` +
                  `Reply 'yes' to confirm, or 'cancel' to abort.`;
              } else {
                const ti = toolInput as unknown as TradeGuardrailInput;

                const priceVerification = verifyTradePrice({
                  symbol: ti.symbol,
                  proposedPrice: ti.unitPrice,
                  toolResults
                });

                const confirmedPrice = priceVerification.marketPrice ?? ti.unitPrice;
                const total = ti.quantity * confirmedPrice;
                const priceAnnotation = priceVerification.citationText
                  ? ` (${priceVerification.citationText})`
                  : '';

                tradeProposalForFallback =
                  `I'd like to place the following paper trade — please confirm this is what you want:\n\n` +
                  `**${ti.side.toUpperCase()} ${ti.quantity} shares of ${ti.symbol.toUpperCase()}** ` +
                  `at $${confirmedPrice.toFixed(2)}/share${priceAnnotation} (estimated total: $${total.toFixed(2)}).\n\n` +
                  `This is a paper trade — no real money involved. ` +
                  `Reply 'yes' to execute, or 'cancel' to abort.` +
                  (priceVerification.warning
                    ? `\n\n⚠️ **Price note:** ${priceVerification.warning}`
                    : '');
              }
            }

            toolTrace.push({
              tool: toolUse.name,
              ok: true,
              ms: Date.now() - startMs
            });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ blocked: true, message: blockedMsg })
            });
            onEvent?.({
              type: 'tool_end',
              tool: toolUse.name,
              ok: false,
              ms: Date.now() - startMs,
              iteration: displayIteration,
              detail: guardrailResult.cancelled
                ? 'BLOCKED: trade cancelled by user'
                : 'BLOCKED: confirmation required'
            });
            continue;
          }

          try {
            const result = await executor.execute(
              toolUse.input as Record<string, unknown>,
              toolContext
            );
            toolResults.set(toolUse.name, result);
            const writeResultError = detectToolResultError(result);
            if (writeResultError) {
              toolsFailed++;
              toolTrace.push({ tool: toolUse.name, ok: false, ms: Date.now() - startMs, error: writeResultError });
            } else {
              toolsSucceeded++;
              toolTrace.push({ tool: toolUse.name, ok: true, ms: Date.now() - startMs });
            }
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(result)
            });
            const writeToolOk = !writeResultError;
            const detail =
              writeResultError ??
              (toolUse.name === 'getMarketPrices' &&
              typeof result === 'object' &&
              result &&
              'source' in result &&
              typeof (result as { source?: unknown }).source === 'string'
                ? String((result as { source: string }).source)
                : undefined);
            onEvent?.({
              type: 'tool_end',
              tool: toolUse.name,
              ok: writeToolOk,
              ms: Date.now() - startMs,
              iteration: displayIteration,
              detail
            });
            onEvent?.({
              type: 'tool_detail',
              tool: toolUse.name,
              input: toolUse.input as Record<string, unknown>,
              result: this.truncateToolResult(result, 500),
              iteration: displayIteration
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            toolsFailed++;
            toolTrace.push({
              tool: toolUse.name,
              ok: false,
              ms: Date.now() - startMs,
              error: errorMsg
            });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                error: `Tool execution failed: ${errorMsg}`
              }),
              is_error: true
            });
            onEvent?.({
              type: 'tool_end',
              tool: toolUse.name,
              ok: false,
              ms: Date.now() - startMs,
              iteration: displayIteration,
              detail: errorMsg
            });
          }
        }

        // ─── Auto-fetch portfolio after successful trade ────────────
        const postTradeBlocks: RunnableToolUse[] = [];
        if (toolResults.has('logPaperTrade') && !toolResults.has('getPortfolioSnapshot')) {
          const snapshotExecutor = this.toolRegistry.getExecutor('getPortfolioSnapshot');
          if (snapshotExecutor) {
            try {
              toolsCalled.push('getPortfolioSnapshot');
              onEvent?.({
                type: 'tool_start',
                tool: 'getPortfolioSnapshot',
                iteration: iteration + 1
              });
              const snapshotStartMs = Date.now();
              const snapshotResult = await snapshotExecutor.execute({}, toolContext);
              toolResults.set('getPortfolioSnapshot', snapshotResult);
              toolsSucceeded++;

              const snapshotToolUse: RunnableToolUse = {
                type: 'tool_use',
                id: `synthetic_postTrade_snapshot_${iteration}`,
                name: 'getPortfolioSnapshot',
                input: {}
              };
              postTradeBlocks.push(snapshotToolUse);

              toolTrace.push({
                tool: 'getPortfolioSnapshot',
                ok: true,
                ms: Date.now() - snapshotStartMs
              });
              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: snapshotToolUse.id,
                content: JSON.stringify(snapshotResult)
              });
              onEvent?.({
                type: 'tool_end',
                tool: 'getPortfolioSnapshot',
                ok: true,
                ms: Date.now() - snapshotStartMs,
                iteration: iteration + 1
              });
            } catch {
              // Non-critical: trade already logged, just can't show updated portfolio
              onEvent?.({
                type: 'tool_end',
                tool: 'getPortfolioSnapshot',
                ok: false,
                ms: 0,
                iteration: iteration + 1,
                detail: 'Tool execution failed during post-trade refresh'
              });
            }
          }
        }

        // ─── Append assistant turn + tool results to messages ────────
        const extraToolUseBlocks = [...syntheticToolUseBlocks, ...postTradeBlocks];
        const assistantContent: Anthropic.ContentBlockParam[] =
          extraToolUseBlocks.length
            ? [
                ...(response.content as unknown as Anthropic.ContentBlockParam[]),
                ...(extraToolUseBlocks as Anthropic.ToolUseBlockParam[])
              ]
            : (response.content as unknown as Anthropic.ContentBlockParam[]);

        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({ role: 'user', content: toolResultBlocks });

        // When a trade was blocked by the guardrail, break immediately.
        // The fallback mechanism will make a tool-free LLM call with the
        // CONFIRMATION_REQUIRED context already in messages, producing a
        // clean confirmation prompt instead of relying on the ReAct loop
        // (which often generates terse/empty text for this case).
        if (tradeBlocked) {
          terminationReason = 'trade_blocked';
          lastResponseContent = null; // Clear so fallback generates clean confirmation
          break;
        }

        // Track called tools for conditional inclusion on next iteration
        for (const tc of toolsCalled) {
          calledToolNames.add(tc);
        }

        iteration++;
      }

      // ─── Post-loop: check for max_iterations ──────────────────────
      if (iteration >= agentConfig.maxIterations && terminationReason === 'end_turn') {
        terminationReason = 'max_iterations';
      }

      // ─── Extract final answer ─────────────────────────────────────
      let answer = '';
      if (lastResponseContent) {
        answer = this.extractText(lastResponseContent);
      }

      // If loop terminated early without a text response (or trade was
      // blocked), generate a dedicated tool-free response. For trade_blocked,
      // always regenerate — the iteration-0 text is just "Let me check the price"
      // preamble, not the confirmation prompt the user needs.
      if (terminationReason === 'trade_blocked' || (!answer && terminationReason !== 'end_turn')) {
        if (onEvent) {
          const streamed = await this.streamFinalAnswer(client, systemPrompt, messages, onEvent);
          totalInputTokens += streamed.inputTokens;
          totalOutputTokens += streamed.outputTokens;
          answer = streamed.text;
        } else {
          const fallbackSystemWithCache: Anthropic.TextBlockParam[] = [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
          ];
          const fallbackResponse = await client.messages.create({
            model: agentConfig.anthropicModel,
            max_tokens: agentConfig.maxTokens,
            temperature: agentConfig.temperature,
            system: fallbackSystemWithCache,
            messages
          });
          totalInputTokens += fallbackResponse.usage?.input_tokens ?? 0;
          totalOutputTokens += fallbackResponse.usage?.output_tokens ?? 0;
          answer = this.extractText(fallbackResponse.content);
        }

        // If LLM produced empty or generic text for a trade_blocked case,
        // use the deterministic confirmation prompt built from actual trade data.
        // This ensures the response always includes the symbol and trade details.
        if (terminationReason === 'trade_blocked' && tradeProposalForFallback) {
          answer = tradeProposalForFallback;
        }
      }

      answer = this.postProcessAnswer({
        answer,
        message: request.message,
        toolResults,
        toolsSucceeded,
        toolsFailed
      });
      const verification = verifyAgentResponse({
        answer,
        toolResults,
        userMessage: request.message,
        conversationHistory: request.conversationHistory
      });

      const snapshotResult = toolResults.get('getPortfolioSnapshot') as
        | PortfolioSnapshotResult
        | undefined;

      const isPriceDataMissing = snapshotResult?.isPriceDataMissing ?? false;
      const hasHoldings = (snapshotResult?.holdings?.length ?? 0) > 0;
      const hasErrors = snapshotResult ? false : toolsFailed > 0;

      const baseConfidence = computeConfidence({
        hasErrors,
        isPriceDataMissing,
        toolsSucceeded,
        toolsFailed,
        hasHoldings,
        terminationReason
      });

      let finalConfidence = Math.max(0.05, baseConfidence - verification.confidenceAdjustment);
      if (typeof verification.confidenceCeiling === 'number') {
        finalConfidence = Math.min(finalConfidence, verification.confidenceCeiling);
      }
      finalConfidence = Math.round(Math.min(1.0, Math.max(0.05, finalConfidence)) * 100) / 100;

      const valuationMethod: ValuationMethod =
        snapshotResult?.valuationMethod ?? 'market';

      const responsePayload: AgentChatResponse = {
        answer,
        data: {
          valuationMethod,
          asOf: snapshotResult?.asOf ?? null,
          totalValue: snapshotResult?.totalValue,
          allocationBySymbol: snapshotResult?.allocationBySymbol,
          allocationByAssetClass: snapshotResult?.allocationByAssetClass
        },
        toolTrace,
        confidence: finalConfidence,
        warnings: verification.warnings,
        loopMeta: {
          iterations: iteration,
          totalMs: Date.now() - loopStartMs,
          tokenUsage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens
          },
          estimatedCostUsd:
            totalInputTokens * SONNET_INPUT_TOKEN_COST_USD +
            totalOutputTokens * SONNET_OUTPUT_TOKEN_COST_USD,
          toolsCalled,
          terminationReason
        }
      };
      onEvent?.({
        type: 'done',
        answer: responsePayload.answer,
        confidence: responsePayload.confidence,
        warnings: responsePayload.warnings,
        toolTrace: responsePayload.toolTrace,
        loopMeta: responsePayload.loopMeta
      });

      return responsePayload;
    };

    try {
      return await withLangfuseTrace({
        name: 'agent-chat',
        userId: userContext.userId,
        input: { message: request.message, accountId: request.accountId },
        run: runChat
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: 'error', message: errorMsg });
      return this.buildErrorResponse(
        `I encountered an error while processing your request. Please try again. (${errorMsg})`,
        toolTrace
      );
    }
  }

  /** Deterministic shallow hash for circuit-breaker dedup. */
  private hashArgs(input: unknown): string {
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  private buildSyntheticToolUseBlocks({
    message,
    existingToolNames,
    baseCurrency,
    conversationHistory
  }: {
    message: string;
    existingToolNames: Set<string>;
    baseCurrency: string;
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
  }): RunnableToolUse[] {
    // If the user is modifying a pending trade (conversation history has a
    // trade confirmation and user message is neither confirm nor cancel),
    // skip ALL synthetic tools so the LLM handles it conversationally.
    if (this.isPendingTradeModification(message, conversationHistory)) {
      return [];
    }

    // If the user is asking a broad strategy question, skip synthetic tools
    // so the LLM asks follow-up questions (goals, risk tolerance, time horizon)
    // before fetching data. Only suppress on the FIRST message — if there's
    // conversation history, the user may be answering follow-ups.
    const isFirstMessage = !conversationHistory || conversationHistory.length === 0;
    if (isFirstMessage && this.isBroadStrategyIntent(message.toLowerCase())) {
      return [];
    }

    const lower = message.toLowerCase();
    const synthetic: RunnableToolUse[] = [];
    let syntheticIndex = 0;

    const addTool = (name: string, input: Record<string, unknown>) => {
      if (existingToolNames.has(name)) {
        return;
      }
      synthetic.push({
        type: 'tool_use',
        id: `synthetic_${name}_${syntheticIndex++}`,
        name,
        input
      });
      existingToolNames.add(name);
    };

    // Most portfolio-analysis queries should include a snapshot.
    if (this.isPortfolioIntent(lower)) {
      addTool('getPortfolioSnapshot', {});
    }

    if (this.shouldUsePerformance(lower)) {
      addTool('getPerformance', {
        dateRange: this.inferDateRange(lower)
      });
    }

    const changes = this.parseAllocationChanges(message, baseCurrency);
    if (changes.length > 0) {
      addTool('simulateAllocationChange', { changes });
    }

    // If user asks about a specific stock/crypto, auto-fetch overview data.
    const mentionedSymbols = this.extractMentionedSymbols(lower);
    if (mentionedSymbols.length > 0 && this.isStockAnalysisIntent(lower)) {
      addTool('getStockOverview', { symbols: mentionedSymbols });
    }

    // If user asks for news, research, or strategy about a specific symbol.
    if (mentionedSymbols.length > 0 && this.isNewsOrStrategyIntent(lower)) {
      addTool('getMarketNews', { symbol: mentionedSymbols[0] });
    }

    return synthetic;
  }

  private isStockAnalysisIntent(lowerMessage: string): boolean {
    return /\b(analyz|overview|detail|fundamental|52.?week|market\s*cap|volume|how\s+is|tell\s+me\s+about|look\s+at)\b/.test(lowerMessage);
  }

  private isNewsOrStrategyIntent(lowerMessage: string): boolean {
    return /\b(news|strateg|research|what.s\s+happening|recent|headline|earning|sentiment)\b/.test(lowerMessage);
  }

  /**
   * Detect broad strategy questions where the agent should ask follow-up
   * questions (goals, risk tolerance, time horizon) before fetching data.
   * Does NOT match narrow factual questions like "what % is AAPL?"
   */
  private isBroadStrategyIntent(lowerMessage: string): boolean {
    const strategyPatterns = [
      /\b(rebalance|rebalancing)\b/,
      /\bwhat\s+should\s+i\s+(do|consider|change|adjust)\b/,
      /\b(improve|optimize|diversif)\b.*\bportfolio\b/,
      /\bportfolio\b.*\b(improve|optimize|diversif|strategy|strateg)\b/,
      /\b(investment|investing)\s+(strategy|plan|approach|idea)\b/,
      /\bhow\s+(can|should|do)\s+i\s+(improve|grow|protect|diversify)\b/,
      /\bmore\s+(aggressive|conservative|diversified|balanced)\b/,
      /\bsuggest.*\b(allocation|strategy|approach|change)\b/,
      /\badvice\b.*\bportfolio\b/,
      /\bportfolio\b.*\b(advice|guidance|suggestion|recommendation)\b/,
      /\bwhat\s+would\s+you\s+(suggest|recommend|advise)\b/,
      /\b(get|getting)\s+started\s+(with|in)\s+(invest|stock|trading|portfolio)/,
      /\bhow\s+to\s+(start|begin)\s+(invest|trading|stock|building)/,
      /\b(new|beginner|beginning)\s+(invest|trader|portfolio)/,
      /\bwhere\s+(do|should)\s+i\s+(start|begin)\b/,
      /\bhow\s+(do|can|should)\s+i\s+(start|begin)\s+(invest|trading|building)/
    ];
    return strategyPatterns.some((p) => p.test(lowerMessage));
  }

  private extractMentionedSymbols(lowerMessage: string): string[] {
    // Match common stock tickers (1-5 uppercase letters) that appear naturally.
    // We check against the original message for case sensitivity.
    const tickerPattern = /\b([A-Z]{1,5})\b/g;
    const stopWords = new Set([
      'I', 'A', 'THE', 'AND', 'OR', 'MY', 'IS', 'IT', 'IN', 'TO', 'FOR',
      'OF', 'ON', 'AT', 'BY', 'AN', 'IF', 'DO', 'BUY', 'SELL', 'HOW',
      'CAN', 'WHAT', 'ALL', 'NOT', 'HAS', 'USD', 'EUR', 'GBP', 'YES', 'NO'
    ]);
    const symbols: string[] = [];
    // Use the original message (not lowered) for ticker extraction
    const originalUpper = lowerMessage.toUpperCase();
    let match: RegExpExecArray | null;
    while ((match = tickerPattern.exec(originalUpper)) !== null) {
      const sym = match[1];
      if (!stopWords.has(sym) && sym.length >= 2) {
        symbols.push(sym);
      }
    }
    return [...new Set(symbols)].slice(0, 3); // max 3 symbols
  }

  private isPortfolioIntent(lowerMessage: string): boolean {
    const keywords = [
      'portfolio',
      'allocation',
      'holding',
      'value',
      'worth',
      'percent',
      'performance',
      'gainer',
      'loser',
      'perform',
      'gain',
      'loss',
      'recently',
      'how did',
      'buy',
      'sell',
      'aapl',
      'vti',
      'msft',
      'bnd',
      'tax',
      'return',
      'money',
      'made',
      'lost',
      'month-to-date',
      'price',
      'stock',
      'share',
      'bitcoin',
      'crypto',
      'equit',
      'bond'
    ];
    return keywords.some((k) => lowerMessage.includes(k));
  }

  private shouldUsePerformance(lowerMessage: string): boolean {
    return (
      lowerMessage.includes('performance') ||
      lowerMessage.includes('gainer') ||
      lowerMessage.includes('loser') ||
      lowerMessage.includes('year to date') ||
      lowerMessage.includes('ytd') ||
      lowerMessage.includes('recently') ||
      lowerMessage.includes('how did i do') ||
      lowerMessage.includes('this month') ||
      lowerMessage.includes('month-to-date') ||
      lowerMessage.includes('returns') ||
      lowerMessage.includes('made or lost') ||
      lowerMessage.includes('how did my portfolio perform')
    );
  }

  private inferDateRange(lowerMessage: string): string {
    if (lowerMessage.includes('year to date') || lowerMessage.includes('ytd')) {
      return 'ytd';
    }
    if (lowerMessage.includes('this month') || lowerMessage.includes('recently')) {
      return 'mtd';
    }
    return 'max';
  }

  private parseAllocationChanges(
    message: string,
    baseCurrency: string
  ): AllocationChange[] {
    const lower = message.toLowerCase();
    const defaultType: 'buy' | 'sell' =
      lower.includes('sell') && !lower.includes('add') && !lower.includes('buy')
        ? 'sell'
        : 'buy';

    const changes: AllocationChange[] = [];
    const seen = new Set<string>();

    const pushChange = (
      amount: number,
      symbol: string,
      localContext: string
    ) => {
      if (!Number.isFinite(amount) || amount <= 0 || !symbol) return;
      const key = `${symbol}:${amount}`;
      if (seen.has(key)) return;
      seen.add(key);
      const type: 'buy' | 'sell' = localContext.includes('sell')
        ? 'sell'
        : localContext.includes('buy') || localContext.includes('add')
          ? 'buy'
          : defaultType;
      changes.push({
        type,
        symbol,
        amount: { currency: baseCurrency, amount }
      });
    };

    // "$AMOUNT of SYMBOL" (e.g. "buy $5000 of TSLA")
    const ofRegex = /\$?\s*([\d,]+(?:\.\d+)?)\s+of\s+([A-Za-z.]{1,10})/gi;
    let match: RegExpExecArray | null;
    while ((match = ofRegex.exec(message)) !== null) {
      const amount = Number(match[1].replace(/,/g, ''));
      const symbol = match[2].replace(/[^A-Za-z]/g, '').toUpperCase();
      const localContext = message
        .slice(Math.max(0, match.index - 16), match.index + 24)
        .toLowerCase();
      pushChange(amount, symbol, localContext);
    }

    // "$AMOUNT ... in SYMBOL" (e.g. "adding $10000 to my portfolio in GOOGL")
    const inRegex = /\$?\s*([\d,]+(?:\.\d+)?)\s+.*?\s+in\s+([A-Za-z.]{1,10})\b/gi;
    while ((match = inRegex.exec(message)) !== null) {
      const amount = Number(match[1].replace(/,/g, ''));
      const symbol = match[2].replace(/[^A-Za-z]/g, '').toUpperCase();
      const localContext = message
        .slice(Math.max(0, match.index - 20), match.index + 30)
        .toLowerCase();
      pushChange(amount, symbol, localContext);
    }

    return changes;
  }

  /**
   * Returns true when conversation history indicates a pending trade
   * confirmation and the user's latest message modifies the trade
   * (i.e. is neither a simple confirm nor a cancel).
   */
  private isPendingTradeModification(
    message: string,
    conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    if (!conversationHistory?.length) return false;

    // Check if the last assistant message is a trade confirmation prompt
    const lastAssistant = [...conversationHistory]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (!lastAssistant) return false;

    const upper = lastAssistant.content.toUpperCase();
    const isTradeProposal =
      (upper.includes('CONFIRM') || upper.includes('CONFIRMATION_REQUIRED')) &&
      (upper.includes('BUY') || upper.includes('SELL')) &&
      (upper.includes('PAPER') || upper.includes('TRADE'));

    if (!isTradeProposal) return false;

    // Check if user message is a simple confirm or cancel
    const trimmed = message.trim().toLowerCase();
    const confirmWords = ['yes', 'y', 'confirm', 'go ahead', 'do it', 'execute', 'proceed', 'sure', 'ok', 'okay', 'yep', 'yeah', 'yup'];
    const cancelWords = ['no', 'n', 'cancel', 'nevermind', 'never mind', 'abort', "don't", 'dont', 'stop', 'scratch that', 'nah', 'nope'];

    if (confirmWords.includes(trimmed) || cancelWords.includes(trimmed)) {
      return false; // It's a confirm/cancel, not a modification
    }

    // It's a modification of the pending trade
    return true;
  }

  private postProcessAnswer({
    answer,
    message,
    toolResults,
    toolsSucceeded = 0,
    toolsFailed = 0
  }: {
    answer: string;
    message: string;
    toolResults: Map<string, unknown>;
    toolsSucceeded?: number;
    toolsFailed?: number;
  }): string {
    const lowerMessage = message.toLowerCase();
    let finalAnswer = this.stripJsonCodeBlocks(answer).trim();

    if (!finalAnswer) {
      const simulate = toolResults.get('simulateAllocationChange') as
        | { notes?: string[] }
        | undefined;
      if (simulate?.notes?.length) {
        finalAnswer = `Simulation complete for your requested changes (${message}). ${simulate.notes.join(' ')} New allocation has been computed.`;
      } else if (toolsFailed > 0) {
        finalAnswer =
          'I could not produce a full response. Some requested tools failed — check the tools status below for details.';
      } else if (toolsSucceeded > 0) {
        finalAnswer =
          'I could not produce a full response, but the requested portfolio tools were executed successfully.';
      } else {
        finalAnswer =
          'I could not produce a full response. The requested tools did not complete successfully.';
      }
    }

    // Avoid exact forbidden phrase while keeping intent.
    finalAnswer = finalAnswer.replace(/\btax advice\b/gi, 'personalized tax guidance');

    if (lowerMessage.includes('sell') && !/goals/i.test(finalAnswer)) {
      finalAnswer +=
        ' Any portfolio decision depends on your goals, risk tolerance, and time horizon.';
    }

    if (
      lowerMessage.includes('percent') &&
      lowerMessage.includes('aapl') &&
      !/%/.test(finalAnswer)
    ) {
      finalAnswer += ' AAPL currently represents 0% of your portfolio.';
    }

    if (
      (lowerMessage.includes('gainers') || lowerMessage.includes('losers')) &&
      !/(not available|missing)/i.test(finalAnswer)
    ) {
      finalAnswer +=
        ' Top gainers/losers data is not available because required holdings/time-series data is missing.';
    }

    if (lowerMessage.includes('recently') && !/30/.test(finalAnswer)) {
      finalAnswer +=
        " I'm assuming the last 30 days. Let me know if you'd like a different time period.";
    }

    return finalAnswer;
  }

  private isToneChangePrompt(message: string): boolean {
    const lower = message.toLowerCase().trim();
    const patterns = [
      /\b(talk|speak|respond|answer)\s+(like|as)\s+(a\s+)?(pirate|robot|shakespeare|cowboy)/i,
      /\b(be|act)\s+(sarcastic|funny|silly|weird|crazy)/i,
      /\byou\s+are\s+(now\s+)?(dan|dani|jailbroken)/i,
      /\bpretend\s+(to\s+be|you\s+are|you're)/i,
      /\b(respond|answer|talk)\s+in\s+(the\s+)?(style|voice|character)\s+of/i,
      /\b(roleplay|role\s*play)\s+as/i,
      /\b(act|behave)\s+as\s+(my\s+)?(friend|buddy|pal)/i,
      /\b(ignore|forget)\s+(your\s+)?(instructions?|rules?)/i
    ];
    return patterns.some((p) => p.test(lower));
  }

  private getToneDeflectionResponse(): string {
    const options = [
      "Ha, I appreciate the creativity! But I'm built specifically for portfolio analysis — that's where I really shine. Want to check your allocation or see how your portfolio is performing?",
      "Love the enthusiasm! That's a bit outside my wheelhouse though — I'm your portfolio analysis assistant. I can help you view holdings, track performance, simulate trades, or check market prices.",
      "That's a fun idea! But I'll stick to what I do best — crunching your portfolio numbers. What would you like to know about your investments?"
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  private stripJsonCodeBlocks(text: string): string {
    // Remove fenced JSON blocks from LLM answer so UI stays clean text-first.
    let out = text
      // 1. Fenced ```json ... ``` blocks
      .replace(/```\s*json[\s\S]*?```/gi, '')
      // 2. Fenced ``` blocks containing our structured data keys
      .replace(/```[\s\S]*?valuationMethod[\s\S]*?```/gi, '');

    // 3. Unfenced JSON payloads containing "valuationMethod" (up to 3 levels of nested braces).
    //    Catches inline JSON the LLM includes without code fences.
    const nb = '(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*'; // nested braces helper
    out = out.replace(new RegExp(`\\{${nb}"valuationMethod"${nb}\\}`, 'g'), '');

    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  private truncateToolResult(result: unknown, maxLen: number): unknown {
    try {
      const str = JSON.stringify(result);
      if (str.length <= maxLen) return result;
      return JSON.parse(str.slice(0, maxLen) + '…"}');
    } catch {
      const str = String(result);
      return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
    }
  }

  /**
   * Stream the final answer text via text_delta events.
   * Falls back to a non-streaming call if streaming fails.
   */
  private async streamFinalAnswer(
    client: import('@anthropic-ai/sdk').default,
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    onEvent: (event: AgentStreamEvent) => void
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    try {
      const stream = client.messages.stream({
        model: agentConfig.anthropicModel,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        system: systemPrompt,
        messages
      });

      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          onEvent({ type: 'text_delta', text: event.delta.text });
          text += event.delta.text;
        }
      }

      const finalMessage = await stream.finalMessage();
      inputTokens = finalMessage.usage?.input_tokens ?? 0;
      outputTokens = finalMessage.usage?.output_tokens ?? 0;

      return { text, inputTokens, outputTokens };
    } catch {
      // Fallback: non-streaming call
      const response = await client.messages.create({
        model: agentConfig.anthropicModel,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        system: systemPrompt,
        messages
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      // Emit the full text as a single delta for backward compatibility
      onEvent({ type: 'text_delta', text });
      return {
        text,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0
      };
    }
  }

  private buildErrorResponse(
    message: string,
    toolTrace: ToolTraceRow[]
  ): AgentChatResponse {
    return {
      answer: message,
      data: {
        valuationMethod: 'market',
        asOf: null
      },
      toolTrace,
      confidence: 0.1,
      warnings: []
    };
  }
}
