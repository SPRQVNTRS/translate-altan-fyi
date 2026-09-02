/**
 * LLM Service
 *
 * Centralized factory for creating LLM clients.
 *
 * Usage:
 * ```typescript
 * import { getLLMForTask } from '#app/lib/llm';
 *
 * const client = getLLMForTask('DEFAULT');
 * const result = await client.createStructuredResponse({ prompt, schema });
 * ```
 */

import { LLM, type LlmClientInterface, type LlmProvider } from '@sprqvntrs/llm';
import { MODELS, LLM_CONFIG, type ModelKey } from '#app/config/llm';
import { createComponentLogger } from '#app/lib/logger';

const logger = createComponentLogger('LLMService');

/**
 * Error thrown when LLM configuration is invalid or missing
 */
export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMConfigError';
  }
}

/**
 * Create an LLM client for a specific provider and model.
 */
export function createLLMClient(provider: LlmProvider, model: string): LlmClientInterface {
  const apiKey = LLM_CONFIG.getApiKey(provider);

  if (!apiKey) {
    const envVar =
      provider === 'openai'
        ? 'OPENAI_API_KEY'
        : provider === 'anthropic'
          ? 'ANTHROPIC_API_KEY'
          : 'OPENROUTER_API_KEY';

    logger.error(`Missing API key for provider: ${provider}`, { provider, envVar });
    throw new LLMConfigError(`Missing ${envVar} environment variable`);
  }

  logger.debug('Creating LLM client', { provider, model });

  return LLM.getClient(provider, model, {
    apiKey,
    openaiApiKey: LLM_CONFIG.openaiFormatterKey,
  });
}

/**
 * Get an LLM client configured for a specific task type.
 */
export function getLLMForTask(taskType: ModelKey): LlmClientInterface {
  const config = MODELS[taskType];
  logger.debug('Getting LLM for task', { taskType, provider: config.provider, model: config.model });
  return createLLMClient(config.provider, config.model);
}

export type { LlmClientInterface, LlmProvider };
