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

describe('AgentService', () => {
  let originalApiKey: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

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
    global.fetch = originalFetch;
  });

  it('returns a direct response when model does not call tools', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hello from agent' }],
      stop_reason: 'end_turn'
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
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Snapshot complete' }],
      stop_reason: 'end_turn'
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
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Performance complete' }],
      stop_reason: 'end_turn'
    });

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
      { message: 'performance?' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en',
        jwt: 'jwt-token'
      }
    );

    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0].tool).toBe('getPerformance');
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
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'Your portfolio is 100% in AAPL, total value $1,855.'
        }
      ],
      stop_reason: 'end_turn'
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
    expect(result.confidence).toBeGreaterThan(0);
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
      stop_reason: 'tool_use'
    });
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'I was unable to load your portfolio due to a temporary error. Please try again.'
        }
      ],
      stop_reason: 'end_turn'
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
    expect(result.toolTrace[0].error).toBeDefined();
    expect(result.answer).toBeDefined();
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
