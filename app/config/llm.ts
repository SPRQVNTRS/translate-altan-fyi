/**
 * LLM Configuration
 *
 * Task-specific model presets and provider configuration.
 *
 * Usage:
 * ```typescript
 * import { MODELS, LLM_CONFIG } from '#app/config/llm';
 * import { getLLMForTask } from '#app/lib/llm';
 *
 * const client = getLLMForTask('DEFAULT');
 * ```
 */

import type { LlmProvider } from '@sprqvntrs/llm';

// ============================================
// MODEL DEFINITIONS
// ============================================

/**
 * Task-specific model configuration.
 * Add more entries as needed for different use cases.
 */
export const MODELS = {
  /**
   * Default model for general-purpose tasks.
   * Good balance of quality, speed, and cost.
   */
  DEFAULT: {
    provider: 'openrouter' satisfies LlmProvider,
    model: 'openai/gpt-5.6-luna',
  },
} as const;

// ============================================
// PROVIDER CONFIGURATION
// ============================================

/**
 * LLM configuration with lazy API key resolution.
 */
export const LLM_CONFIG = {
  /**
   * Get the API key for a specific provider.
   */
  getApiKey(provider: LlmProvider): string | undefined {
    switch (provider) {
      case 'openai':
        return process.env.OPENAI_API_KEY || undefined;
      case 'anthropic':
        return process.env.ANTHROPIC_API_KEY || undefined;
      case 'openrouter':
        return process.env.OPENROUTER_API_KEY || undefined;
    }
  },

  /**
   * OpenAI API key for structured formatting (used by OpenRouter/Anthropic).
   */
  get openaiFormatterKey(): string | undefined {
    return process.env.OPENAI_API_KEY || undefined;
  },

  /** Default retry attempts */
  maxAttempts: 3,
} as const;

// ============================================
// TYPE EXPORTS
// ============================================

export type ModelKey = keyof typeof MODELS;
