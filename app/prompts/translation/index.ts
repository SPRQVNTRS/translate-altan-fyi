/**
 * The translation prompt: the markdown template, and the one function that fills
 * it in.
 *
 * THE TEMPLATE IS READ LAZILY, AND THE READ SURVIVES BUNDLING.
 *   `react-router build` bundles this module into `build/server/index.js`, and
 *   the production server runs THAT BUNDLE, not these sources (ADR-0004). Two
 *   things follow, and both have already broken a boot in this repo.
 *
 *   First, `import.meta.url` MOVES when the module is bundled. It points at
 *   `build/server/`, where no markdown file is ever emitted, so a path resolved
 *   from it alone is correct under `tsx` (the worker) and wrong in production.
 *   The candidate list therefore tries the `import.meta.url` location first and
 *   falls back to the repo-relative copy under `process.cwd()`, which
 *   `Dockerfile.pnpm` genuinely ships.
 *
 *   Second, the read is inside `renderTranslationPrompt` rather than at module
 *   load. A module that cannot be imported without touching the disk is a module
 *   that can kill a boot. Lazily, the same fault is one failed translation.
 *
 *   Nothing cheaper catches this. `tsc`, `oxlint` and the unit tier all run the
 *   UNBUNDLED sources, where `import.meta.url` is right, so all three stay green.
 *
 * THE PLACEHOLDER GUARD IS THE POINT OF THIS MODULE.
 *   Substitution is find-and-replace, and find-and-replace fails silently.
 *   Rename `{{lemma}}` in the markdown and every rendered prompt would carry the
 *   LITERAL text `{{lemma}}` where the word should be. The model would answer,
 *   the answer would parse, and the rows would be about nothing. Nothing else in
 *   the chain can notice that, so the substitution refuses to return a string
 *   that still holds a placeholder. The guard itself lives in the enrichment
 *   prompt module and is imported: one implementation, so the two prompts cannot
 *   drift into two different definitions of "unresolved".
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { MAX_SENSES, MAX_TRANSLATIONS_PER_SENSE } from '#app/lib/translation/limits';
import { PromptFileNotShippedError, substitutePlaceholders } from '#app/prompts/enrichment';

export { PROMPT_VERSION } from './version';

/** Where the markdown sits, relative to the repository root. */
const PROMPT_PATH_FROM_REPO_ROOT = 'app/prompts/translation/v1.md';

/** The template, once it has been read. `null` until the first render. */
let cachedTemplate: string | null = null;

/** Whether the template has already been read into memory. The unit tier's seam. */
export function isTemplateLoaded(): boolean {
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
export function promptPathCandidates(): string[] {
  return [fileURLToPath(new URL('./v1.md', import.meta.url)), resolve(process.cwd(), PROMPT_PATH_FROM_REPO_ROOT)];
}

/** The first candidate path that exists. */
function resolvePromptPath(): string {
  const candidates = promptPathCandidates();
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

/** What the prompt says when the dictionary records no part of speech. */
const POS_NOT_RECORDED = 'not recorded';

/** One sense the dictionary already holds, as the prompt lists it. */
export interface OfferedSense {
  senseId: string;
  /** Whatever wording the dictionary has for it, in any language. May be empty. */
  glosses: string[];
}

/** Everything the template needs filled in. */
export interface RenderTranslationPromptParams {
  lemma: string;
  /** `null` when the dictionary records no part of speech for this headword. */
  pos: string | null;
  from: LanguageCode;
  to: LanguageCode;
  /**
   * The senses the dictionary already holds, or an empty list.
   *
   * EMPTY IS THE COMMON CASE and it is not an error: about ninety three percent
   * of the German headwords here carry no sense at all, which is the whole
   * reason this feature exists. An empty list switches the prompt into its
   * authoring instruction and the caller into the authoring answer schema.
   */
  senses: OfferedSense[];
}

/**
 * The instruction that changes with the two shapes.
 *
 * A lookup keyed on the branch rather than a ternary in the render call, so both
 * wordings sit side by side and neither can be edited without seeing the other.
 */
const TASKS = {
  translateGiven:
    "The senses above are the dictionary's own. Return one object per sense, carrying back its " +
    '`senseId` EXACTLY as it is given above. Do not invent a sense, do not merge two senses, and ' +
    'do not drop one. Do not return a `senseId` that is not in the list.',
  authorSenses:
    'The dictionary holds no senses for this headword yet, so write them. Return one object per ' +
    'distinct meaning, with a `localId` of your own choosing to tell them apart, a `pos`, and a ' +
    '`gloss`: one short line saying what the sense means, written in {{fromLanguageName}}. Give ' +
    'the everyday meanings first and leave out rare or archaic ones.',
} satisfies Record<'translateGiven' | 'authorSenses', string>;

/**
 * The senses, as the markdown list the template expects.
 *
 * The sense id is written first and verbatim, because the model has to hand it
 * back on every object it returns. That id is what binds an answer to the row it
 * describes; a rewritten or prettified id would make the answer unattachable.
 */
function renderSenses(senses: OfferedSense[]): string {
  if (senses.length === 0) return 'The dictionary holds no senses for this headword.';
  return senses
    .map((sense) => {
      const glosses = sense.glosses.map((gloss) => `  - ${gloss}`).join('\n');
      const body = glosses === '' ? '  - (no gloss recorded)' : glosses;
      return `- Sense \`${sense.senseId}\`\n${body}`;
    })
    .join('\n');
}

/**
 * Render the translation prompt for one headword.
 *
 * @param params The headword, the direction, and the senses the dictionary
 *   already holds, which may be none.
 * @returns The prompt text to send to the model.
 * @throws PromptFileNotShippedError when the markdown is on none of the paths it
 *   is expected to be on, which means the image was built without it.
 * @throws UnresolvedPlaceholderError when the template holds a placeholder this
 *   function does not fill, which means the markdown and this file have drifted.
 */
export function renderTranslationPrompt(params: RenderTranslationPromptParams): string {
  const fromLanguageName = LANGUAGE_NAMES[params.from];
  const task = params.senses.length === 0 ? TASKS.authorSenses : TASKS.translateGiven;
  return substitutePlaceholders(loadTemplate(), {
    lemma: params.lemma,
    pos: params.pos ?? POS_NOT_RECORDED,
    fromLanguageName,
    toLanguageName: LANGUAGE_NAMES[params.to],
    senses: renderSenses(params.senses),
    // The authoring instruction names the source language, so it is substituted
    // before it is substituted INTO the template. Doing it the other way round
    // would leave a `{{fromLanguageName}}` inside the task text, and the guard
    // below would refuse the whole prompt.
    task: task.replaceAll('{{fromLanguageName}}', fromLanguageName),
    maxSenses: String(MAX_SENSES),
    maxTranslations: String(MAX_TRANSLATIONS_PER_SENSE),
  });
}
