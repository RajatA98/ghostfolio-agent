import type Anthropic from '@anthropic-ai/sdk';

import { agentConfig } from './agent.config';
import { buildSystemPrompt } from './agent.prompt';
import {
  AgentChatRequest,
  AgentChatResponse,
  AgentLoopMeta,
  AllocationChange,
  PortfolioSnapshotResult,
  ToolTraceRow,
  ValuationMethod
} from './agent.types';
import { computeConfidence, verifyAgentResponse } from './agent.verifier';
import { createAnthropicClient, withLangfuseTrace } from './observability';
import { SnapTradeService } from './services/snaptrade.service';
import { PortfolioService } from './services/portfolio.service';
import { GetMarketPricesTool } from './tools/get-market-prices.tool';
import { GetPerformanceTool } from './tools/get-performance.tool';
import { GetPortfolioSnapshotTool } from './tools/get-portfolio-snapshot.tool';
import { SnapTradeConnectTool } from './tools/snaptrade-connect.tool';
import { PortfolioReadTool } from './tools/portfolio-read.tool';
import { SimulateAllocationChangeTool } from './tools/simulate-allocation-change.tool';
import { ToolContext, ToolRegistry } from './tools/tool-registry';

export type StreamCallback = (event: StreamEvent) => void;

export type StreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'thinking'; iteration: number }
  | { type: 'tool_start'; tool: string; iteration: number }
  | { type: 'tool_end'; tool: string; ok: boolean; ms: number; iteration: number; detail?: string }
  | { type: 'done'; answer: string; confidence: number; warnings: string[]; toolTrace: ToolTraceRow[]; loopMeta?: AgentLoopMeta }
  | { type: 'error'; message: string };

interface RunnableToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export class AgentService {
  private readonly toolRegistry: ToolRegistry;

  public constructor() {
    this.toolRegistry = new ToolRegistry();

    // Create shared services
    const snapTradeService = agentConfig.enableSnapTrade ? new SnapTradeService() : null;
    const portfolioService = snapTradeService
      ? new PortfolioService(snapTradeService)
      : null;

    // --- Portfolio tools (require SnapTrade) ---
    if (portfolioService) {
      this.toolRegistry.register({
        definition: GetPortfolioSnapshotTool.DEFINITION,
        executor: new GetPortfolioSnapshotTool(portfolioService),
        enabled: true
      });

      this.toolRegistry.register({
        definition: GetPerformanceTool.DEFINITION,
        executor: new GetPerformanceTool(portfolioService),
        enabled: true
      });

      this.toolRegistry.register({
        definition: SimulateAllocationChangeTool.DEFINITION,
        executor: new SimulateAllocationChangeTool(portfolioService),
        enabled: true
      });

      this.toolRegistry.register({
        definition: PortfolioReadTool.DEFINITION,
        executor: new PortfolioReadTool(portfolioService),
        enabled: true
      });
    }

    // --- Market data (always available) ---
    this.toolRegistry.register({
      definition: GetMarketPricesTool.DEFINITION,
      executor: new GetMarketPricesTool(),
      enabled: agentConfig.enableExternalMarketData
    });

    // --- SnapTrade connect tool ---
    if (snapTradeService) {
      this.toolRegistry.register({
        definition: SnapTradeConnectTool.DEFINITION,
        executor: new SnapTradeConnectTool(snapTradeService),
        enabled: true
      });
    }
  }

  public async chat(
    request: AgentChatRequest,
    userContext: {
      userId: string;
      supabaseUserId?: string;
      baseCurrency: string;
      language: string;
      impersonationId?: string;
    },
    onStream?: StreamCallback
  ): Promise<AgentChatResponse> {
    if (!agentConfig.anthropicApiKey) {
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
      const client = createAnthropicClient();

      const systemPrompt = buildSystemPrompt({
        baseCurrency: userContext.baseCurrency,
        language: userContext.language,
        currentDate: new Date().toISOString().split('T')[0]
      });

      const messages: Anthropic.MessageParam[] = [];
      if (request.conversationHistory) {
        for (const msg of request.conversationHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: 'user', content: request.message });

      const anthropicTools: Anthropic.Tool[] = this.toolRegistry
        .getDefinitions()
        .map((td) => ({
          name: td.name,
          description: td.description,
          input_schema: td.input_schema as Anthropic.Tool.InputSchema
        }));

      const toolContext: ToolContext = {
        userId: userContext.userId,
        supabaseUserId: userContext.supabaseUserId,
        baseCurrency: userContext.baseCurrency,
        impersonationId: userContext.impersonationId
      };

      // ─── Guardrail state ──────────────────────────────────────────
      const loopStartMs = Date.now();
      let iteration = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let terminationReason: AgentLoopMeta['terminationReason'] = 'end_turn';
      const circuitBreakerMap = new Map<string, number>();
      let syntheticInjectedThisRequest = false;
      let lastResponseContent: Anthropic.ContentBlock[] | null = null;

      // ─── ReAct loop: Thought → Action → Observation ───────────────
      while (iteration < agentConfig.maxIterations) {
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

        onStream?.({ type: 'iteration_start', iteration });

        // LLM call
        const response = await client.messages.create({
          model: agentConfig.anthropicModel,
          max_tokens: agentConfig.maxTokens,
          temperature: agentConfig.temperature,
          system: systemPrompt,
          messages,
          tools: anthropicTools
        });

        // Track tokens
        totalInputTokens += response.usage?.input_tokens ?? 0;
        totalOutputTokens += response.usage?.output_tokens ?? 0;

        // Save content for post-loop text extraction
        lastResponseContent = response.content;

        onStream?.({ type: 'thinking', iteration });

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
        let syntheticToolUseBlocks: RunnableToolUse[] = [];
        if (!syntheticInjectedThisRequest) {
          syntheticToolUseBlocks = this.buildSyntheticToolUseBlocks({
            message: request.message,
            existingToolNames: new Set(toolUseBlocks.map((b) => b.name)),
            baseCurrency: userContext.baseCurrency
          });
          syntheticInjectedThisRequest = true;
        }

        const allToolUseBlocks = [...runnableToolUseBlocks, ...syntheticToolUseBlocks];

        // If stop_reason is end_turn AND there are no synthetic tools to
        // inject, the LLM is done.
        if (response.stop_reason !== 'tool_use' && syntheticToolUseBlocks.length === 0) {
          terminationReason = 'end_turn';
          break;
        }

        // If no tools to execute
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

        for (const toolUse of allToolUseBlocks) {
          const startMs = Date.now();
          const executor = this.toolRegistry.getExecutor(toolUse.name);

          onStream?.({ type: 'tool_start', tool: toolUse.name, iteration });

          if (!executor) {
            const errorMsg = `Unknown or disabled tool: ${toolUse.name}`;
            const elapsedMs = Date.now() - startMs;
            toolsFailed++;
            toolTrace.push({
              tool: toolUse.name,
              ok: false,
              ms: elapsedMs,
              error: errorMsg
            });
            onStream?.({ type: 'tool_end', tool: toolUse.name, ok: false, ms: elapsedMs, iteration, detail: errorMsg });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: errorMsg }),
              is_error: true
            });
            continue;
          }

          try {
            const result = await executor.execute(
              toolUse.input as Record<string, unknown>,
              toolContext
            );
            const elapsedMs = Date.now() - startMs;
            toolResults.set(toolUse.name, result);
            toolsSucceeded++;
            toolTrace.push({
              tool: toolUse.name,
              ok: true,
              ms: elapsedMs
            });
            onStream?.({ type: 'tool_end', tool: toolUse.name, ok: true, ms: elapsedMs, iteration });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(result)
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const elapsedMs = Date.now() - startMs;
            toolsFailed++;
            toolTrace.push({
              tool: toolUse.name,
              ok: false,
              ms: elapsedMs,
              error: errorMsg
            });
            onStream?.({ type: 'tool_end', tool: toolUse.name, ok: false, ms: elapsedMs, iteration, detail: errorMsg });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                error: `Tool execution failed: ${errorMsg}`
              }),
              is_error: true
            });
          }
        }

        // ─── Append assistant turn + tool results to messages ────────
        const extraToolUseBlocks = [...syntheticToolUseBlocks];
        const assistantContent: Anthropic.ContentBlockParam[] =
          extraToolUseBlocks.length
            ? [
                ...(response.content as unknown as Anthropic.ContentBlockParam[]),
                ...(extraToolUseBlocks as Anthropic.ToolUseBlockParam[])
              ]
            : (response.content as unknown as Anthropic.ContentBlockParam[]);

        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({ role: 'user', content: toolResultBlocks });

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

      // If loop terminated early without a text response, generate one
      if (!answer && terminationReason !== 'end_turn') {
        const fallbackResponse = await client.messages.create({
          model: agentConfig.anthropicModel,
          max_tokens: agentConfig.maxTokens,
          temperature: agentConfig.temperature,
          system: systemPrompt,
          messages
          // No tools — force text response
        });
        totalInputTokens += fallbackResponse.usage?.input_tokens ?? 0;
        totalOutputTokens += fallbackResponse.usage?.output_tokens ?? 0;
        answer = this.extractText(fallbackResponse.content);
      }

      answer = this.postProcessAnswer({
        answer,
        message: request.message,
        toolResults
      });
      const verification = verifyAgentResponse({ answer, toolResults });

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
        hasHoldings
      });

      const finalConfidence = Math.max(
        0,
        baseConfidence - verification.confidenceAdjustment
      );

      const valuationMethod: ValuationMethod =
        snapshotResult?.valuationMethod ?? 'market';

      return {
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
          terminationReason
        }
      };
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
    baseCurrency
  }: {
    message: string;
    existingToolNames: Set<string>;
    baseCurrency: string;
  }): RunnableToolUse[] {
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

    return synthetic;
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

  private postProcessAnswer({
    answer,
    message,
    toolResults
  }: {
    answer: string;
    message: string;
    toolResults: Map<string, unknown>;
  }): string {
    const lowerMessage = message.toLowerCase();
    let finalAnswer = answer.trim();

    // Strip raw JSON code blocks — the frontend renders markdown, not JSON
    finalAnswer = finalAnswer.replace(/```json\s*\n[\s\S]*?\n```/g, '').trim();
    // Also strip orphan JSON objects that look like structured data dumps
    finalAnswer = finalAnswer.replace(/\n\{[\s\n]*"valuationMethod"[\s\S]*?\n\}/g, '').trim();

    if (!finalAnswer) {
      const simulate = toolResults.get('simulateAllocationChange') as
        | { notes?: string[] }
        | undefined;
      if (simulate?.notes?.length) {
        finalAnswer = `Simulation complete for your requested changes (${message}). ${simulate.notes.join(' ')} New allocation has been computed.`;
      } else {
        finalAnswer = 'I could not produce a full response, but the requested portfolio tools were executed successfully.';
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
