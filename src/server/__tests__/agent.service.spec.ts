import { AgentService } from '../agent.service';

const mockCreate = jest.fn();
const mockFetch = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate
      }
    }))
  };
});

/** Helper: standard usage block for mock responses. */
const mockUsage = (input = 100, output = 50) => ({
  input_tokens: input,
  output_tokens: output
});

describe('AgentService', () => {
  let originalApiKey: string | undefined;
  let originalFetch: typeof global.fetch;
  let originalMaxIterations: string | undefined;
  let originalCircuitBreaker: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    originalMaxIterations = process.env.AGENT_MAX_ITERATIONS;
    originalCircuitBreaker = process.env.AGENT_CIRCUIT_BREAKER_THRESHOLD;

    originalFetch = global.fetch;
    (global as any).fetch = mockFetch;

    mockCreate.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalMaxIterations === undefined) {
      delete process.env.AGENT_MAX_ITERATIONS;
    } else {
      process.env.AGENT_MAX_ITERATIONS = originalMaxIterations;
    }
    if (originalCircuitBreaker === undefined) {
      delete process.env.AGENT_CIRCUIT_BREAKER_THRESHOLD;
    } else {
      process.env.AGENT_CIRCUIT_BREAKER_THRESHOLD = originalCircuitBreaker;
    }
    global.fetch = originalFetch;
  });

  it('returns a direct response when model does not call tools', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello from agent' }],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'hello' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.answer).toContain('Hello from agent');
    expect(result.toolTrace).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('executes HTTP-backed getPortfolioSnapshot tool', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'getPortfolioSnapshot',
          input: { dateRange: 'max' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Snapshot complete' }],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'allocation?' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0].tool).toBe('getPortfolioSnapshot');
    expect(result.toolTrace[0].ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/portfolio/details');
    expect(result.data.allocationBySymbol?.length).toBe(1);
  });

  it('executes getPerformance from v2 endpoint', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'getPerformance',
          input: { dateRange: 'mtd' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Performance complete' }],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    // "performance?" triggers synthetic getPortfolioSnapshot via isPortfolioIntent,
    // so we need two fetch mocks: one for getPerformance, one for getPortfolioSnapshot.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        chart: [
          { date: '2026-01-01', netWorth: 1000, netPerformanceInPercentage: 0.1 }
        ],
        performance: { netPerformancePercentage: 0.1 }
      })
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'performance?' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    // 2 tools: model-requested getPerformance + synthetic getPortfolioSnapshot
    expect(result.toolTrace).toHaveLength(2);
    expect(result.toolTrace[0].tool).toBe('getPerformance');
    expect(result.toolTrace[0].ok).toBe(true);
    expect(result.toolTrace[1].tool).toBe('getPortfolioSnapshot');
    expect(result.toolTrace[1].ok).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toContain('/api/v2/portfolio/performance');
  });

  it('returns synthesized answer and data when tools succeed', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'getPortfolioSnapshot',
          input: { dateRange: 'max' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'Your portfolio is 100% in AAPL, total value $1,855.'
        }
      ],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'Summarize my portfolio' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.answer).toContain('portfolio');
    expect(result.data.valuationMethod).toBeDefined();
    expect(result.toolTrace[0].ok).toBe(true);
    // Tools succeeded, has holdings, no price data missing → confidence = 1.0
    expect(result.confidence).toBe(1.0);
    expect(result.data.allocationBySymbol!.length).toBe(1);
    expect(result.data.allocationBySymbol![0].key).toBe('AAPL');
  });

  it('handles tool execution failure gracefully and returns response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'getPortfolioSnapshot',
          input: { dateRange: 'max' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'I was unable to load your portfolio due to a temporary error. Please try again.'
        }
      ],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const service = new AgentService();
    const result = await service.chat(
      { message: 'Show my allocation' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0].ok).toBe(false);
    expect(result.toolTrace[0].error).toContain('Network error');
    expect(result.answer).toBeDefined();
    // All tools failed, none succeeded → confidence = 0.1
    expect(result.confidence).toBe(0.1);
  });

  // ─── New guardrail tests ────────────────────────────────────────

  it('includes loopMeta in response with token usage', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'getPortfolioSnapshot',
          input: {}
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage(500, 200)
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: mockUsage(800, 300)
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'portfolio value?' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.loopMeta).toBeDefined();
    expect(result.loopMeta!.iterations).toBe(1);
    expect(result.loopMeta!.terminationReason).toBe('end_turn');
    expect(result.loopMeta!.tokenUsage.inputTokens).toBe(1300);
    expect(result.loopMeta!.tokenUsage.outputTokens).toBe(500);
    expect(result.loopMeta!.tokenUsage.totalTokens).toBe(1800);
    expect(result.loopMeta!.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('terminates on max iterations', async () => {
    process.env.AGENT_MAX_ITERATIONS = '2';

    // Always return tool_use — the loop should terminate after 2 iterations
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tool_loop',
          name: 'getPortfolioSnapshot',
          input: {}
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'portfolio?' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.loopMeta).toBeDefined();
    expect(result.loopMeta!.terminationReason).toBe('max_iterations');
    expect(result.loopMeta!.iterations).toBe(2);
  });

  it('triggers circuit breaker when same tool called repeatedly', async () => {
    process.env.AGENT_CIRCUIT_BREAKER_THRESHOLD = '2';
    process.env.AGENT_MAX_ITERATIONS = '10';

    // Return the same tool_use with same args every time
    const sameToolResponse = {
      content: [
        {
          type: 'tool_use',
          id: 'tool_repeat',
          name: 'getPortfolioSnapshot',
          input: { dateRange: 'max' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    };

    mockCreate.mockResolvedValue(sameToolResponse);

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'portfolio?' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.loopMeta).toBeDefined();
    expect(result.loopMeta!.terminationReason).toBe('circuit_breaker');
    // First call executes (count=1), second call triggers breaker (count=2 >= threshold=2)
    expect(result.loopMeta!.iterations).toBeLessThanOrEqual(2);
  });

  it('supports multi-turn: LLM calls tools then calls more tools', async () => {
    // Iteration 0: LLM calls getPortfolioSnapshot
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'getPortfolioSnapshot',
          input: {}
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });

    // Iteration 1: LLM sees snapshot and calls getPerformance
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_2',
          name: 'getPerformance',
          input: { dateRange: 'ytd' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });

    // Iteration 2: LLM is done
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here is your full portfolio analysis.' }],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    // Fetch for getPortfolioSnapshot
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        holdings: {
          AAPL: {
            symbol: 'AAPL',
            name: 'Apple',
            currency: 'USD',
            quantity: 10,
            marketPrice: 185.5,
            investment: 1500,
            valueInBaseCurrency: 1855,
            assetClass: 'EQUITY'
          }
        }
      })
    });

    // Fetch for getPerformance
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        hasErrors: false,
        chart: [
          { date: '2026-01-01', netWorth: 1000, netPerformanceInPercentage: 0.1 }
        ],
        performance: { netPerformancePercentage: 0.1 }
      })
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'Give me a complete analysis of my portfolio' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    // Should have traced both tools
    const toolNames = result.toolTrace.map((t) => t.tool);
    expect(toolNames).toContain('getPortfolioSnapshot');
    expect(toolNames).toContain('getPerformance');

    // LLM was called 3 times (2 tool_use + 1 end_turn)
    expect(mockCreate).toHaveBeenCalledTimes(3);

    // 2 iterations in the loop
    expect(result.loopMeta).toBeDefined();
    expect(result.loopMeta!.iterations).toBe(2);
    expect(result.loopMeta!.terminationReason).toBe('end_turn');
    expect(result.answer).toContain('portfolio analysis');
  });
});
