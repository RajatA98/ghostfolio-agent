import type Anthropic from '@anthropic-ai/sdk';

import { agentConfig } from './agent.config';

export type AnthropicClient = Anthropic;

export function createAnthropicClient(): AnthropicClient {
  const AnthropicSdk = require('@anthropic-ai/sdk').default;
  const base = new AnthropicSdk({ apiKey: agentConfig.anthropicApiKey });

  if (agentConfig.langsmithTracing && agentConfig.langsmithApiKey) {
    try {
      const { wrapAnthropic } = require('langsmith/wrappers/anthropic');
      return wrapAnthropic(base, {
        project_name: agentConfig.langsmithProject
      }) as AnthropicClient;
    } catch (e) {
      if (process.env.NODE_ENV !== 'test') {
        // eslint-disable-next-line no-console
        console.warn('[agent] LangSmith wrap skipped:', (e as Error).message);
      }
    }
  }

  return base;
}

export type LangfuseTraceFn<T> = () => Promise<T>;

export async function withLangfuseTrace<T>(options: {
  name: string;
  userId?: string;
  input: unknown;
  run: LangfuseTraceFn<T>;
}): Promise<T> {
  if (!agentConfig.langfuseEnabled) {
    return options.run();
  }

  try {
    const { startActiveObservation } = require('@langfuse/tracing');
    return await startActiveObservation(
      options.name,
      async (span: any) => {
        span.update({
          metadata: {
            userId: options.userId,
            project: 'portfolio-analyzer'
          },
          input: options.input
        });
        const result = await options.run();
        span.update({ output: result as unknown });
        return result;
      },
      { asType: 'trace' }
    );
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn('[agent] Langfuse trace skipped:', (e as Error).message);
    }
    return options.run();
  }
}
