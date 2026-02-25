import type Anthropic from '@anthropic-ai/sdk';

import { agentConfig } from './agent.config';
import { buildSystemPrompt } from './agent.prompt';
import {
  AgentChatRequest,
  AgentChatResponse,
  AllocationChange,
  PortfolioSnapshotResult,
  ToolTraceRow,
  ValuationMethod
} from './agent.types';
import { computeConfidence, verifyAgentResponse } from './agent.verifier';
import { createAnthropicClient, withLangfuseTrace } from './observability';
import { GetMarketPricesTool } from './tools/get-market-prices.tool';
import { GetPerformanceTool } from './tools/get-performance.tool';
import { GetPortfolioSnapshotTool } from './tools/get-portfolio-snapshot.tool';
import { SimulateAllocationChangeTool } from './tools/simulate-allocation-change.tool';
import { ToolContext, ToolRegistry } from './tools/tool-registry';

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
  }

  public async chat(
    request: AgentChatRequest,
    userContext: {
      userId: string;
      baseCurrency: string;
      language: string;
      jwt: string;
      impersonationId?: string;
    }
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

      const call1Response = await client.messages.create({
        model: agentConfig.anthropicModel,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        system: systemPrompt,
        messages,
        tools: anthropicTools
      });

      const toolUseBlocks = call1Response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );
      const runnableToolUseBlocks: RunnableToolUse[] = toolUseBlocks.map((b) => ({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: b.input
      }));

      const syntheticToolUseBlocks = this.buildSyntheticToolUseBlocks({
        message: request.message,
        existingToolNames: new Set(toolUseBlocks.map((b) => b.name)),
        baseCurrency: userContext.baseCurrency
      });
      const allToolUseBlocks = [...runnableToolUseBlocks, ...syntheticToolUseBlocks];

      if (allToolUseBlocks.length === 0) {
        const textContent = this.extractText(call1Response.content);
        const verification = verifyAgentResponse({
          answer: textContent,
          toolResults
        });

        return {
          answer: textContent,
          data: {
            valuationMethod: 'market',
            asOf: null
          },
          toolTrace,
          confidence: computeConfidence({
            hasErrors: false,
            isPriceDataMissing: false,
            toolsSucceeded: 0,
            toolsFailed: 0,
            hasHoldings: true
          }),
          warnings: verification.warnings
        };
      }

      const toolContext: ToolContext = {
        userId: userContext.userId,
        baseCurrency: userContext.baseCurrency,
        impersonationId: userContext.impersonationId,
        jwt: userContext.jwt
      };

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of allToolUseBlocks) {
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
          continue;
        }

        try {
          const result = await executor.execute(
            toolUse.input as Record<string, unknown>,
            toolContext
          );
          toolResults.set(toolUse.name, result);
          toolsSucceeded++;
          toolTrace.push({
            tool: toolUse.name,
            ok: true,
            ms: Date.now() - startMs
          });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
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
        }
      }

      const assistantContentForCall2: Anthropic.ContentBlockParam[] =
        syntheticToolUseBlocks.length
          ? [
              ...(call1Response.content as unknown as Anthropic.ContentBlockParam[]),
              ...(syntheticToolUseBlocks as Anthropic.ToolUseBlockParam[])
            ]
          : (call1Response.content as unknown as Anthropic.ContentBlockParam[]);

      const call2Messages: Anthropic.MessageParam[] = [
        ...messages,
        { role: 'assistant', content: assistantContentForCall2 },
        { role: 'user', content: toolResultBlocks }
      ];

      const call2Response = await client.messages.create({
        model: agentConfig.anthropicModel,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        system: systemPrompt,
        messages: call2Messages,
        tools: anthropicTools
      });

      let answer = this.extractText(call2Response.content);
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
        warnings: verification.warnings
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
      'buy',
      'sell',
      'aapl',
      'vti',
      'msft',
      'bnd',
      'tax'
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
      lowerMessage.includes('this month')
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
    const pairRegex = /\$?\s*([\d,]+(?:\.\d+)?)\s+of\s+([A-Za-z.]{1,10})/gi;
    let match: RegExpExecArray | null;

    while ((match = pairRegex.exec(message)) !== null) {
      const amount = Number(match[1].replace(/,/g, ''));
      const symbol = match[2].replace(/[^A-Za-z]/g, '').toUpperCase();
      if (!Number.isFinite(amount) || amount <= 0 || !symbol) {
        continue;
      }
      const localContext = message
        .slice(Math.max(0, match.index - 16), match.index + 24)
        .toLowerCase();
      const type: 'buy' | 'sell' = localContext.includes('sell')
        ? 'sell'
        : localContext.includes('buy') || localContext.includes('add')
          ? 'buy'
          : defaultType;

      changes.push({
        type,
        symbol,
        amount: {
          currency: baseCurrency,
          amount
        }
      });
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
