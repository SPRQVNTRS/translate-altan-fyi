import { z } from 'zod';
import type { LlmProvider, LlmTokenUsage, ReasoningEffortLevel } from '@sprqvntrs/llm';

import { createLLMClient } from '#app/lib/llm';
import {
  type ActiveModelSelection,
  type ProviderId,
  estimateCostUsd,
  modelPrice,
  providerEntry,
} from '#app/lib/llm/catalog';

// =============================================================================
// The LLM registry
// =============================================================================
// One seam between this app and @sprqvntrs/llm. The enrichment workflow never
// names a provider: it hands the active model and a prompt to `complete` and
// gets a validated result back. Everything that knows a provider exists lives
// here or in the catalog beside it.
//
// The vendor client is reached through the owned `LlmPort` interface below
// rather than directly, for two reasons. A test can inject a fake and never
// touch a live API, and a future change of client library is a new adapter
// instead of an edit to every caller.
// =============================================================================

/** The active model as the registry receives it. Structurally the model file's `ActiveModel`. */
export type ActiveModel = ActiveModelSelection;

export interface LlmCompletionRequest<T extends z.ZodType> {
  prompt: string;
  schema: T;
  reasoningEffort?: ReasoningEffortLevel;
  timeoutMs: number;
}

export interface LlmCompletionResult<TOut> {
  output: TOut;
  /** Total USD for the call, or null when neither pricing source could put a number on it. See `resolveCostUsd`. */
  costUsd: number | null;
  latencyMs: number;
  provider: ProviderId;
  model: string;
}

/** The owned port over the vendor client. The only thing a test needs to replace. */
export interface LlmPort {
  complete<T extends z.ZodType>(request: LlmCompletionRequest<T>): Promise<{ output: z.infer<T>; costUsd: number | null }>;
}

/** Thrown when the active provider's API key is absent from the environment. */
export class LlmNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/** Thrown when the active model is asked for an option its provider cannot express. */
export class LlmCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmCapabilityError';
  }
}

/** A validated model selection, resolved down to the transport that will carry it. */
export interface ConfiguredModel {
  provider: ProviderId;
  model: string;
  transport: LlmProvider;
  reasoningEffort?: ReasoningEffortLevel;
}

export type RegistryStatus = { configured: true } | { configured: false; reason: string };

/** The injected port, or null when the real adapter should be built. See `withProvider`. */
let injectedPort: LlmPort | null = null;

/**
 * Read an API key from the environment.
 *
 * An empty string counts as absent: an unset variable and one set to nothing are
 * the same operator mistake, and only one of them would otherwise reach the
 * provider as a malformed credential.
 *
 * @returns the key, or null. The VALUE never leaves this function.
 */
function readApiKey(envVar: string): string | null {
  const raw = process.env[envVar];
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Put a USD figure on a completed call, from the two sources we have.
 *
 * ORDER OF PREFERENCE, AND WHY IT IS THIS WAY
 *   1. `usage.cost.total` from @sprqvntrs/llm. That is the provider's own
 *      accounting for THIS call, so it already accounts for cached input and for
 *      a price that moved since anyone last looked. Ours is a hand-kept table
 *      that goes stale silently, so the library wins whenever it has an answer.
 *   2. Our `MODEL_PRICES` row times the token counts the provider reported. The
 *      library returns `cost: null` for any model missing from its own pricing
 *      table, and the DEFAULT model `google/gemini-3.7-flash` is one of them:
 *      without this step `cost_usd` was null on every row ever written, and a
 *      budget cap in currency would have had nothing to read.
 *   3. null, when the call reported no usage at all or the model has no price
 *      row. Null and not zero, because a zero reads downstream as a free call
 *      and a cap that sums free calls never triggers.
 *
 * @param usage - the client's `lastUsage` for the call just made.
 * @param model - the configured model id, which is the key into our table.
 */
function resolveCostUsd(usage: LlmTokenUsage | null, model: string): number | null {
  if (usage === null) return null;
  const reported = usage.cost?.total;
  if (reported !== undefined) return reported;
  const price = modelPrice(model);
  if (price === null) return null;
  return estimateCostUsd(price, usage.promptTokens, usage.completionTokens);
}

/**
 * Build the real port for a configured model.
 *
 * `maxAttempts: 1` is deliberate. The caller owns the single retry, so a retry is
 * a visible second call with its own latency and its own cost line. Letting the
 * library retry inside one call would hide the second attempt from every metric
 * we keep, and a run that silently cost twice as much would look identical to
 * one that did not.
 */
function createRealPort(configured: ConfiguredModel): LlmPort {
  const client = createLLMClient(configured.transport, configured.model);
  return {
    async complete<T extends z.ZodType>(request: LlmCompletionRequest<T>) {
      // The per-request effort wins, and the configured one is the fallback, so a
      // caller that says nothing still gets the model the operator selected.
      const reasoningEffort = request.reasoningEffort ?? configured.reasoningEffort;
      const output = await client.createStructuredResponse({
        prompt: request.prompt,
        schema: request.schema,
        maxAttempts: 1,
        stream: false,
        timeout: request.timeoutMs,
        ...(reasoningEffort !== undefined && { reasoningEffort }),
      });
      return { output, costUsd: resolveCostUsd(client.lastUsage, configured.model) };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Audio in, text out                                                          */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS SECTION EXISTS AT ALL.
 *   @sprqvntrs/llm 3.13.1 has no audio input: every client in it takes a prompt
 *   string. The voice fallback needs a model to listen to a recording, and the
 *   rule that the registry is the ONLY place a provider, a model or an API key
 *   is read still holds. So the audio call is built here, beside the text one,
 *   rather than in the route or the service, and the key still never leaves
 *   this file.
 *
 * THE WIRE FORMAT IS THE OPENAI CHAT SHAPE.
 *   OpenRouter and OpenAI both take an `input_audio` content part on
 *   `/chat/completions`. That covers every catalog entry except the direct
 *   Anthropic one, whose messages API has no audio part at all; asking it is a
 *   capability error rather than a silent text-only call.
 */

/** One recording, on its way to a model. */
export interface AudioTranscriptionRequest {
  /** The clip, base64 encoded. It is built once, by the caller, and never written anywhere. */
  audioBase64: string;
  /** The container name the provider is told, from `app/lib/voice/limits.ts`. */
  format: string;
  /** What the model is asked to do with the clip. Built by the service, never here. */
  instruction: string;
  /** Hard ceiling on the call. See `AUDIO_REQUEST_TIMEOUT_MS` for why one is compulsory. */
  timeoutMs: number;
}

/** What one transcription call produced. */
export interface AudioTranscriptionResult {
  text: string;
  costUsd: number | null;
  latencyMs: number;
  provider: ProviderId;
  model: string;
}

/** The owned port over the audio call. The only thing a test needs to replace. */
export interface AudioPort {
  transcribe(request: AudioTranscriptionRequest): Promise<{ text: string; costUsd: number | null }>;
}

/**
 * The chat completions endpoint for a transport.
 *
 * @throws {LlmCapabilityError} for a transport with no audio-capable chat API.
 */
function audioEndpoint(transport: LlmProvider): string {
  if (transport === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  if (transport === 'openai') return 'https://api.openai.com/v1/chat/completions';
  throw new LlmCapabilityError(
    'The Anthropic messages API carries no audio content part, so this provider cannot transcribe a recording',
  );
}

/**
 * The response this path reads, and nothing more of it.
 *
 * PARSED AT THE BOUNDARY, and every field is optional on purpose. A provider
 * that changed a field this code does not use must not take the voice fallback
 * down, and a provider that returned no transcript must produce an ordinary
 * null the caller turns into a polite answer, never a throw from a property
 * read.
 */
const audioCompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).nullish() }))
    .nullish(),
  usage: z.object({ cost: z.number().nullish() }).nullish(),
});

/**
 * Build the real audio port for a configured model.
 *
 * THE TIMEOUT IS EXPLICIT, AND IT IS NOT OPTIONAL. Memory
 * `reference_node_fetch_hidden_300s_timeout` records undici's hidden 300 second
 * ceiling: a call left to that default holds a request open for five minutes
 * and the reader has long since given up. An upload plus a transcription is the
 * longest single request in this product, which is exactly why it gets the
 * shortest leash anyone would call generous.
 */
function createRealAudioPort(configured: ConfiguredModel, apiKey: string): AudioPort {
  const endpoint = audioEndpoint(configured.transport);
  return {
    async transcribe(request) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: configured.model,
          // `usage.include` is an OpenRouter option and is ignored elsewhere. It
          // is what puts a real price on the call, which is what the day's
          // budget settles against.
          usage: { include: true },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: request.instruction },
                { type: 'input_audio', input_audio: { data: request.audioBase64, format: request.format } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      });

      if (!response.ok) {
        // The body is NOT read into the message. A provider error body can echo
        // the request, and the request here is a recording of a person's voice.
        throw new Error(`The provider refused the transcription with status ${response.status}`);
      }

      // Parsed once, here at the boundary, and read from the decoded value
      // below. Nothing downstream ever sees the raw body.
      const parsed = audioCompletionSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('The provider answered in a shape this client does not understand');

      const text = parsed.data.choices?.[0]?.message?.content ?? null;
      if (text === null) throw new Error('The provider returned no transcript');
      return { text, costUsd: parsed.data.usage?.cost ?? null };
    },
  };
}

/** The injected audio port, or null when the real adapter should be built. See `withAudioPort`. */
let injectedAudioPort: AudioPort | null = null;

export const registry = {
  /**
   * Is the active provider's key present?
   *
   * Never throws, and never reads the key VALUE into the reason string: the
   * status is rendered on an admin page and written to logs.
   */
  describeConfiguration(active: ActiveModel): RegistryStatus {
    const entry = providerEntry(active.provider);
    if (readApiKey(entry.apiKeyEnvVar) === null) {
      return { configured: false, reason: `${entry.apiKeyEnvVar} is not set in the environment` };
    }
    return { configured: true };
  },

  /**
   * Validate the active model against its provider's capabilities and produce the
   * call configuration.
   *
   * It never drops an option. An option the provider cannot express is a hard
   * error, because dropping it would be a silent quality change: the operator
   * sets a value, the UI reports success, and the model runs as if the setting
   * did not exist. Nobody can trace that afterwards.
   *
   * @throws {LlmCapabilityError} for an option this provider cannot transmit.
   * @throws {LlmNotConfiguredError} when the provider's API key is absent.
   */
  configureActiveModel(active: ActiveModel): ConfiguredModel {
    const entry = providerEntry(active.provider);
    if (!entry.capabilities.structuredOutput) {
      // No catalog entry sets this false today. The branch exists so that adding
      // one is impossible without answering the question it asks, since the whole
      // registry returns schema-validated output and has no text-only path.
      throw new LlmCapabilityError(
        `Provider ${entry.label} cannot produce structured output, and the registry has no unstructured path`,
      );
    }
    if (active.options.temperature !== undefined && entry.capabilities.temperature !== 'supported') {
      throw new LlmCapabilityError(
        `Provider ${entry.label} cannot carry the temperature option: @sprqvntrs/llm 3.13.1 transmits no temperature parameter`,
      );
    }
    const requestedEffort = active.options.reasoningEffort;
    if (requestedEffort !== undefined && entry.capabilities.reasoningEffort === 'unsupported') {
      throw new LlmCapabilityError(
        `Provider ${entry.label} cannot carry the reasoningEffort option on this transport`,
      );
    }
    if (requestedEffort !== undefined && requestedEffort !== 'none' && entry.capabilities.reasoningEffort === 'none') {
      throw new LlmCapabilityError(
        `Provider ${entry.label} honours only reasoningEffort 'none', so '${requestedEffort}' would change nothing`,
      );
    }
    const key = readApiKey(entry.apiKeyEnvVar);
    if (key === null) {
      throw new LlmNotConfiguredError(
        `Provider ${entry.label} needs ${entry.apiKeyEnvVar}, which is not set in the environment`,
      );
    }
    return {
      provider: entry.id,
      model: active.model,
      transport: entry.transport,
      ...(requestedEffort !== undefined && { reasoningEffort: requestedEffort }),
    };
  },

  /**
   * The one call the workflow makes. It never names a provider.
   *
   * @param active - the operator's current selection, read per job.
   * @param request - the prompt, the schema its answer must satisfy, and a timeout.
   * @returns the validated output plus what the call cost and how long it took.
   */
  async complete<T extends z.ZodType>(
    active: ActiveModel,
    request: LlmCompletionRequest<T>,
  ): Promise<LlmCompletionResult<z.infer<T>>> {
    const configured = registry.configureActiveModel(active);
    const port = injectedPort ?? createRealPort(configured);
    const startedAt = Date.now();
    const { output, costUsd } = await port.complete(request);
    return {
      output,
      costUsd,
      latencyMs: Date.now() - startedAt,
      provider: configured.provider,
      model: configured.model,
    };
  },

  /**
   * Ask the active model to listen to a recording and write down what it heard.
   *
   * The one call the transcription service makes, and it never names a
   * provider. The clip is passed through, base64 encoded by the caller, and
   * nothing on this path holds it after the promise settles.
   *
   * @param active - the operator's current selection, read per request.
   * @param request - the clip, its container format, the instruction and a timeout.
   * @throws {LlmCapabilityError} when the active provider has no audio path.
   * @throws {LlmNotConfiguredError} when the provider's API key is absent.
   */
  async transcribeAudio(active: ActiveModel, request: AudioTranscriptionRequest): Promise<AudioTranscriptionResult> {
    const configured = registry.configureActiveModel(active);
    const entry = providerEntry(configured.provider);
    // Read again rather than threading the value out of `configureActiveModel`:
    // the key stays a local in the one function that needs it, and the audio
    // port is the only other thing in this file that ever sees it.
    const apiKey = readApiKey(entry.apiKeyEnvVar);
    if (apiKey === null) {
      throw new LlmNotConfiguredError(
        `Provider ${entry.label} needs ${entry.apiKeyEnvVar}, which is not set in the environment`,
      );
    }

    const port = injectedAudioPort ?? createRealAudioPort(configured, apiKey);
    const startedAt = Date.now();
    const { text, costUsd } = await port.transcribe(request);
    return {
      text,
      costUsd,
      latencyMs: Date.now() - startedAt,
      provider: configured.provider,
      model: configured.model,
    };
  },

  /**
   * TEST SEAM. Inject a fake audio port, or pass null to restore the real one.
   *
   * This exists so that no test can reach a live API. Restore it in the test's
   * teardown, otherwise the injection leaks into whatever runs next in the file.
   */
  withAudioPort(port: AudioPort | null): void {
    injectedAudioPort = port;
  },

  /**
   * TEST SEAM. Inject a fake port, or pass null to restore the real one.
   *
   * This exists so that no test can reach a live API. Restore it in the test's
   * teardown, otherwise the injection leaks into whatever runs next in the file.
   */
  withProvider(port: LlmPort | null): void {
    injectedPort = port;
  },
};
