import type { ReasoningEffortLevel } from '@sprqvntrs/llm';

// =============================================================================
// The LLM provider catalog (shared by the server registry and the admin page)
// =============================================================================
// This module is deliberately free of server-only imports. The admin page
// renders the table below, so the file has to survive the client bundle: no
// `process.env`, no database handle, no `.server` module, not even a type-only
// one. Everything here is a plain constant.
//
// WHY A CATALOG AT ALL
//   The enrichment workflow must never name a provider. It asks the registry to
//   complete a prompt, and the registry looks the active model up here. Adding a
//   model is then an edit to this one table, not a change to a call site.
//
// WHAT "SUPPORTED" MEANS HERE
//   Support is an END TO END claim about our own stack, not a claim about the
//   vendor. An option counts as supported only when both the provider AND the
//   client library we send through can carry it. A vendor feature our client
//   cannot transmit is `unsupported`, because from inside this app it does not
//   exist.
// =============================================================================

/** The provider ids the registry can serve. A model outside this list is unreachable. */
export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'gemini';

/** The runtime companion of `ProviderId`, for Zod enums and iteration. */
export const PROVIDER_IDS = ['openrouter', 'openai', 'anthropic', 'gemini'] as const;

/** Whether the registry can express an option END TO END, provider and client library together. */
export type OptionSupport = 'supported' | 'none' | 'unsupported';
//   'supported'   any documented value reaches the provider
//   'none'        only 'none' reaches the provider, graded levels are not honoured
//   'unsupported' the option cannot be transmitted at all

export interface ProviderCapabilities {
  structuredOutput: boolean;
  reasoningEffort: OptionSupport;
  temperature: OptionSupport;
}

export interface CatalogModel {
  id: string;
  label: string;
}

export interface ProviderEntry {
  id: ProviderId;
  label: string;
  /** The @sprqvntrs/llm transport this entry is served through. */
  transport: 'openrouter' | 'openai' | 'anthropic';
  apiKeyEnvVar: 'OPENROUTER_API_KEY' | 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY';
  capabilities: ProviderCapabilities;
  models: CatalogModel[];
  /** Why the entry has the shape it has. Rendered on the admin page. */
  note: string | null;
}

/**
 * The compile-time shape of a model selection.
 *
 * The RUNTIME authority is `activeModelSchema` in
 * `app/models/app-settings.server.ts`, which parses the stored JSON. That module
 * is server-only, so the catalog cannot import it, not even for a type: a
 * `.server` import in a module the client bundle reaches breaks the production
 * build and nothing earlier catches it. The two shapes are kept in step by
 * `DEFAULT_ACTIVE_MODEL` below, which the server module returns as its fallback
 * and would fail to type-check if the shapes drifted apart.
 */
export interface ActiveModelSelection {
  provider: ProviderId;
  model: string;
  options: {
    temperature?: number;
    reasoningEffort?: ReasoningEffortLevel;
  };
}

// -----------------------------------------------------------------------------
// TEMPERATURE IS UNSUPPORTED EVERYWHERE, AND THAT IS A CLIENT CONSTRAINT
// -----------------------------------------------------------------------------
// Every vendor below accepts a temperature. We cannot send one. `temperature`
// appears nowhere in @sprqvntrs/llm 3.13.1 (`grep -rn temperature
// node_modules/@sprqvntrs/llm/src` returns nothing), so no client in this stack
// has a parameter to put it in. The rows say `unsupported` rather than
// `supported` because a setting that silently never leaves the process is worse
// than one the UI refuses.
//
// If a later @sprqvntrs/llm adds the parameter, flip these rows and the registry
// starts accepting the option with no other change.
// -----------------------------------------------------------------------------

export const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    transport: 'openrouter',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    capabilities: {
      structuredOutput: true,
      reasoningEffort: 'supported',
      temperature: 'unsupported',
    },
    models: [
      { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    ],
    note: null,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    transport: 'openai',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    capabilities: {
      structuredOutput: true,
      reasoningEffort: 'supported',
      temperature: 'unsupported',
    },
    models: [
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    ],
    note: 'The direct ids are the OpenRouter ids with the vendor prefix stripped, which is how OpenAI names them. Confirm against the vendor model list before adding another.',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    transport: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    capabilities: {
      structuredOutput: true,
      reasoningEffort: 'supported',
      temperature: 'unsupported',
    },
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
    ],
    note: 'The direct ids are the OpenRouter ids with the vendor prefix stripped, which is how Anthropic names them. Confirm against the vendor model list before adding another.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    // Routed through OpenRouter on purpose, see the note below.
    transport: 'openrouter',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    capabilities: {
      structuredOutput: true,
      // 'none' reaches the model and turns thinking off: @sprqvntrs/llm 3.13.1
      // transmits `reasoning: { effort }` on the OpenRouter path
      // (src/clients/openrouter-client.ts, around line 622). The graded levels
      // low, medium and high are not honoured by Gemini, so accepting them here
      // would let an operator pick a setting that changes nothing.
      reasoningEffort: 'none',
      temperature: 'unsupported',
    },
    models: [
      { id: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    ],
    note: '@sprqvntrs/llm 3.13.1 has no direct Google provider: its LlmProvider union is openai, anthropic, openrouter. Gemini is therefore a registry entry routed through the OpenRouter transport, and it needs the OpenRouter key, not a Google one.',
  },
} satisfies Record<ProviderId, ProviderEntry>;

/**
 * Look a provider up by id.
 *
 * @param id - a member of `PROVIDER_IDS`
 * @returns the catalog entry, which always exists because the key set and the id
 *   union are the same thing.
 */
export function providerEntry(id: ProviderId): ProviderEntry {
  return PROVIDERS[id];
}

// -----------------------------------------------------------------------------
// WHAT A MODEL COSTS
// -----------------------------------------------------------------------------
// WHY THIS TABLE EXISTS AT ALL
//   @sprqvntrs/llm 3.13.1 keeps its own pricing table and reports a cost on
//   `lastUsage.cost`. It does not carry the DEFAULT model,
//   `google/gemini-3.7-flash`, so it returned `cost: null` for every enrichment
//   this app has ever run, and the `cost_usd` column was uniformly null. A daily
//   budget cap expressed in currency needs a column with numbers in it.
//
// PROVENANCE
//   USD per MILLION tokens, read from https://openrouter.ai/api/v1/models on
//   2026-09-02. Nothing refreshes these figures, so treat them as a fallback
//   estimate, not as billing truth. The registry prefers the library's own
//   number whenever it has one, for exactly that reason.
//
// AN UNPRICED MODEL IS null, NEVER A GUESSED ZERO
//   `modelPrice` returns null for a model with no row below. Zero would be the
//   dangerous answer: a budget cap adds costs up, and a model that always costs
//   nothing can never exhaust a budget, so the cap would stop enforcing without
//   failing. EVERY model id in `PROVIDERS` above needs a row here, and adding a
//   model up there without adding one down here is the mistake to avoid.
// -----------------------------------------------------------------------------

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const MODEL_PRICES = {
  // OpenRouter ids, which carry the vendor prefix.
  'google/gemini-3.7-flash': { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 },
  'google/gemini-3.5-flash-lite': { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  'google/gemini-3.1-pro-preview': { inputUsdPerMTok: 2, outputUsdPerMTok: 12 },
  'openai/gpt-5.6-luna': { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 },
  'anthropic/claude-sonnet-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  'anthropic/claude-haiku-4.5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  // The direct-provider ids for the same models. They get their own rows rather
  // than a prefix-stripping rule, because the id an operator picks is what the
  // registry hands us and a rule would silently mis-price the first model whose
  // two names diverge.
  'gpt-5.6-luna': { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2 },
  'gpt-5.4-mini': { inputUsdPerMTok: 0.75, outputUsdPerMTok: 4.5 },
  'claude-sonnet-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  'claude-haiku-4.5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
} satisfies Record<string, ModelPrice>;

// A Map rather than a direct index into `MODEL_PRICES`. `satisfies` keeps the
// literal key set, so indexing it with an arbitrary string needs a type
// assertion, and an assertion here would buy nothing that this Map does not.
const PRICE_BY_MODEL = new Map<string, ModelPrice>(Object.entries(MODEL_PRICES));

/**
 * Look a model's price up.
 *
 * @param model - the id as the operator selected it, either form.
 * @returns the price, or null when the model has no row. See the section comment
 *   above for why null and not zero.
 */
export function modelPrice(model: string): ModelPrice | null {
  return PRICE_BY_MODEL.get(model) ?? null;
}

/**
 * What a call costs at a given price, in USD.
 *
 * Pure arithmetic and deliberately unrounded: the caller decides how to present
 * or store it, and rounding here would accumulate an error across the many small
 * calls a daily budget sums.
 *
 * @param price - a row from `MODEL_PRICES`, in USD per million tokens.
 * @param promptTokens - input tokens, as the provider counted them.
 * @param completionTokens - output tokens, as the provider counted them.
 */
export function estimateCostUsd(price: ModelPrice, promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1e6) * price.inputUsdPerMTok + (completionTokens / 1e6) * price.outputUsdPerMTok;
}

/**
 * The model used when the `llm.active` setting is absent or unreadable.
 *
 * Gemini 3.7 Flash with no options: the cheapest entry that still produces
 * structured output, and the one whose reasoning is off by default.
 */
export const DEFAULT_ACTIVE_MODEL = {
  provider: 'gemini',
  model: 'google/gemini-3.7-flash',
  options: {},
} satisfies ActiveModelSelection;

/** The `app_settings.key` the active model is stored under. */
export const ACTIVE_MODEL_SETTING_KEY = 'llm.active';
