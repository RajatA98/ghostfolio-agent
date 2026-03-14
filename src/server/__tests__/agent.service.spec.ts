import { AgentService } from '../agent.service';

const mockCreate = jest.fn();

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
  let originalMaxIterations: string | undefined;
  let originalCircuitBreaker: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    originalMaxIterations = process.env.AGENT_MAX_ITERATIONS;
    originalCircuitBreaker = process.env.AGENT_CIRCUIT_BREAKER_THRESHOLD;

    mockCreate.mockReset();
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
        language: 'en'
      }
    );

    expect(result.answer).toContain('Hello from agent');
    expect(result.toolTrace).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('includes loopMeta in response with token usage', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: mockUsage(500, 200)
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'hello there' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en'
      }
    );

    expect(result.loopMeta).toBeDefined();
    expect(result.loopMeta!.terminationReason).toBe('end_turn');
    expect(result.loopMeta!.tokenUsage.inputTokens).toBe(500);
    expect(result.loopMeta!.tokenUsage.outputTokens).toBe(200);
    expect(result.loopMeta!.tokenUsage.totalTokens).toBe(700);
    expect(result.loopMeta!.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('handles unknown tool gracefully', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'nonExistentTool',
          input: {}
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'That tool does not exist.' }],
      stop_reason: 'end_turn',
      usage: mockUsage()
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'do something' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en'
      }
    );

    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0].ok).toBe(false);
    expect(result.toolTrace[0].error).toContain('Unknown or disabled tool');
  });

  it('terminates on max iterations', async () => {
    process.env.AGENT_MAX_ITERATIONS = '2';

    // Always return tool_use with unknown tool to loop
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tool_loop',
          name: 'nonExistentTool1',
          input: { iter: Math.random() } // Different args to avoid circuit breaker
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'loop me' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en'
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
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tool_repeat',
          name: 'nonExistentTool',
          input: { dateRange: 'max' }
        }
      ],
      stop_reason: 'tool_use',
      usage: mockUsage()
    });

    const service = new AgentService();
    const result = await service.chat(
      { message: 'repeat test' },
      {
        userId: 'u1',
        baseCurrency: 'USD',
        language: 'en'
      }
    );

    expect(result.loopMeta).toBeDefined();
    expect(result.loopMeta!.terminationReason).toBe('circuit_breaker');
    expect(result.loopMeta!.iterations).toBeLessThanOrEqual(2);
  });
});
