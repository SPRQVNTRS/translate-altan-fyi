/**
 * The phrase prompt: the markdown template, and the one function that fills it
 * in.
 *
 * THE TEMPLATE IS READ LAZILY, AND THE READ SURVIVES BUNDLING.
 *   `react-router build` bundles this module into `build/server/index.js`, and
 *   the production server runs THAT BUNDLE, not these sources (ADR-0004). So
 *   `import.meta.url` MOVES: it points at `build/server/`, where no markdown
 *   file is ever emitted, and a path resolved from it alone is correct under
 *   `tsx` (the worker) and wrong in production. The candidate list therefore
 *   tries the `import.meta.url` location first and falls back to the
 *   repo-relative copy under `process.cwd()`, which `Dockerfile.pnpm` genuinely
 *   ships. The read is inside the render call rather than at module load, so a
 *   missing file is one failed run rather than a dead boot.
 *
 *   Nothing cheaper catches this. `tsc`, `oxlint` and the unit tier all run the
 *   UNBUNDLED sources, where `import.meta.url` is right, so all three stay
 *   green. The same trap, and the same two candidates, as
 *   `app/prompts/translation/index.ts`.
 *
 * THE PLACEHOLDER GUARD IS THE POINT OF THIS MODULE.
 *   Substitution is find-and-replace, and find-and-replace fails silently.
 *   Rename `{{text}}` in the markdown and every rendered prompt would carry the
 *   LITERAL text `{{text}}` where the reader's sentence should be. The model
 *   would answer, the answer would parse, and the reader would be shown a
 *   translation of a placeholder. Nothing else in the chain can notice that, so
 *   the substitution refuses to return a string that still holds one. The guard
 *   itself is imported rather than rewritten, so the three prompts in this repo
 *   cannot drift into three definitions of "unresolved".
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { PromptFileNotShippedError, substitutePlaceholders } from '#app/prompts/enrichment';

export { PHRASE_PROMPT_VERSION } from './version';

/** Where the markdown sits, relative to the repository root. */
const PROMPT_PATH_FROM_REPO_ROOT = 'app/prompts/phrase/v1.md';

/** The template, once it has been read. `null` until the first render. */
let cachedTemplate: string | null = null;

/** Whether the template has already been read into memory. The unit tier's seam. */
export function isPhraseTemplateLoaded(): boolean {
  return cachedTemplate !== null;
}

/**
 * Every place the template may legitimately live, in the order they are tried.
 *
 * 1. Beside this module, which is correct when the TypeScript sources run under
 *    `tsx`. That is how the worker runs.
 * 2. Under the current working directory, which is correct once this module has
 *    been bundled into `build/server/` and the markdown was left behind.
 */
export function phrasePromptPathCandidates(): string[] {
  return [fileURLToPath(new URL('./v1.md', import.meta.url)), resolve(process.cwd(), PROMPT_PATH_FROM_REPO_ROOT)];
}

/** The first candidate path that exists. */
function resolvePromptPath(): string {
  const candidates = phrasePromptPathCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new PromptFileNotShippedError(candidates);
  return found;
}

/** The raw template, read on first use and kept. */
function loadTemplate(): string {
  if (cachedTemplate !== null) return cachedTemplate;
  const template = readFileSync(resolvePromptPath(), 'utf8');
  cachedTemplate = template;
  return template;
}

/**
 * The display name of each served language, in English.
 *
 * `satisfies Record<LanguageCode, string>` rather than an annotation, so the map
 * is checked for COMPLETENESS against `LanguageCode`. Adding a fifth served
 * language then breaks this line at compile time instead of rendering a prompt
 * that names an undefined language at runtime.
 */
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  tr: 'Turkish',
  es: 'Spanish',
} satisfies Record<LanguageCode, string>;

/** Everything the template needs filled in. */
export interface RenderPhrasePromptParams {
  /**
   * The text AS THE READER TYPED IT, trimmed and nothing more.
   *
   * NEVER THE FOLDED FORM. The folded form is the cache key: it is lower case
   * and stripped of punctuation, so translating it would answer a question
   * about a different sentence, and a question mark the reader typed would be
   * gone from the answer.
   */
  text: string;
  from: LanguageCode;
  to: LanguageCode;
}

/**
 * Render the phrase prompt for one piece of text.
 *
 * @param params The text and the direction.
 * @returns The prompt text to send to the model.
 * @throws PromptFileNotShippedError when the markdown is on none of the paths it
 *   is expected to be on, which means the image was built without it.
 * @throws UnresolvedPlaceholderError when the template holds a placeholder this
 *   function does not fill, which means the markdown and this file have drifted.
 */
export function renderPhrasePrompt(params: RenderPhrasePromptParams): string {
  return substitutePlaceholders(loadTemplate(), {
    text: params.text,
    fromLanguageName: LANGUAGE_NAMES[params.from],
    toLanguageName: LANGUAGE_NAMES[params.to],
  });
}
