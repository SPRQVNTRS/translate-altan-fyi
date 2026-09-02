/**
 * The enrichment prompt: the markdown template, and the one function that fills
 * it in.
 *
 * THE TEMPLATE IS READ LAZILY, AND THE READ SURVIVES BUNDLING.
 *   `react-router build` bundles this module into `build/server/index.js`, and
 *   the production server runs THAT BUNDLE, not these sources (ADR-0004). Two
 *   things follow, and both have already broken a boot.
 *
 *   First, `import.meta.url` MOVES when the module is bundled. It points at
 *   `build/server/`, where no markdown file is ever emitted, so a path resolved
 *   from it alone is correct under `tsx` (the worker) and wrong in production.
 *   `resolvePromptPath` therefore tries the `import.meta.url` location first and
 *   falls back to the repo-relative copy under `process.cwd()`, which
 *   `Dockerfile.pnpm` genuinely ships: its final stage inherits `COPY . /app`
 *   with `WORKDIR /app`, so `app/prompts/enrichment/v1.md` is on disk there.
 *
 *   Second, the read is inside `renderEnrichmentPrompt` rather than at module
 *   load. A module that cannot be imported without touching the disk is a module
 *   that can kill a boot, and the route graph imports exactly this module:
 *   `entry.$headwordId` reaches it through the enqueue helper. At module scope a
 *   missing file threw while the server was still wiring itself up, before it
 *   ever listened. Lazily, the same fault is one failed enrichment.
 *
 *   Nothing cheaper catches this. `tsc`, `oxlint` and the unit tier all run the
 *   UNBUNDLED sources, where `import.meta.url` is right, so all three stay green.
 *   Only starting the built server exercises the path that breaks.
 *
 *   The template is memoised after the first successful read, so the per-call
 *   cost is one map lookup and the workflow's hot path keeps no disk read.
 *   Anything that only needs the version number imports `./version` instead, and
 *   pays for none of this.
 *
 * THE PLACEHOLDER GUARD IS THE POINT OF THIS MODULE.
 *   Substitution is find-and-replace, and find-and-replace fails silently. Rename
 *   `{{lemma}}` in the markdown and every rendered prompt would carry the
 *   LITERAL text `{{lemma}}` where the word should be. The model would answer,
 *   the output would parse, the row would be written, and the notes would be
 *   about nothing. Nothing else in the chain can notice that, so
 *   `substitutePlaceholders` refuses to return a string that still holds one.
 *
 *   A missing template is treated the same way, and for the same reason. There is
 *   no empty-string fallback: a blank instruction would still get an answer, and
 *   that answer would still be stored.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
export { PROMPT_VERSION } from './version';

/** Where the markdown sits, relative to the repository root. */
const PROMPT_PATH_FROM_REPO_ROOT = 'app/prompts/enrichment/v1.md';

/**
 * The template, once it has been read. `null` until the first render, which is
 * also the seam the unit tier uses to prove that importing this module reads
 * nothing.
 */
let cachedTemplate: string | null = null;

/** Whether the template has already been read into memory. */
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
  return [
    fileURLToPath(new URL('./v1.md', import.meta.url)),
    resolve(process.cwd(), PROMPT_PATH_FROM_REPO_ROOT),
  ];
}

/** Thrown when no candidate path holds the prompt markdown. */
export class PromptFileNotShippedError extends Error {
  constructor(candidates: string[]) {
    super(
      `The enrichment prompt file was not shipped. Tried ${candidates.join(' and ')}. ` +
        'The markdown is not emitted by the bundler, so it has to travel with the image ' +
        'as a plain file next to the sources.',
    );
    this.name = 'PromptFileNotShippedError';
  }
}

/** How `resolvePromptPath` may be pointed at somewhere other than the real disk. */
export interface ResolvePromptPathOptions {
  /** The paths to try, in order. Defaults to `promptPathCandidates()`. */
  candidates?: string[];
  /** The existence check. Defaults to `existsSync`. */
  exists?: (candidate: string) => boolean;
}

/**
 * The first candidate path that exists.
 *
 * @param options The candidate list and the existence check, both injectable so
 *   the not-shipped branch is testable without moving real files.
 * @returns An absolute path to the prompt markdown.
 * @throws PromptFileNotShippedError when no candidate exists.
 */
export function resolvePromptPath(options: ResolvePromptPathOptions = {}): string {
  const candidates = options.candidates ?? promptPathCandidates();
  const exists = options.exists ?? existsSync;

  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) {
    throw new PromptFileNotShippedError(candidates);
  }
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

/** One sense, as the prompt lists it. */
export interface PromptSense {
  senseId: string;
  glosses: string[];
}

/** Everything the template needs filled in. */
export interface RenderEnrichmentPromptParams {
  lemma: string;
  /** `null` when the dictionary records no part of speech for this headword. */
  pos: string | null;
  from: LanguageCode;
  to: LanguageCode;
  senses: PromptSense[];
}

/** Thrown when a rendered prompt still carries a `{{...}}` placeholder. */
export class UnresolvedPlaceholderError extends Error {
  constructor(placeholders: string[]) {
    super(
      `The enrichment prompt still carries ${placeholders.join(', ')} after substitution. ` +
        'A placeholder in the markdown has no value behind it, most likely because it was ' +
        'renamed on one side only. Sending this prompt would ask the model about the literal ' +
        'placeholder text.',
    );
    this.name = 'UnresolvedPlaceholderError';
  }
}

/** A fresh matcher every time, so no `lastIndex` is ever shared between calls. */
function placeholderPattern(): RegExp {
  return /\{\{([A-Za-z0-9_]+)\}\}/g;
}

/**
 * Replace every `{{name}}` in `template` with its value, and refuse to return a
 * string that still holds one.
 *
 * @param template The raw markdown.
 * @param values One entry per placeholder the template is expected to carry.
 * @returns The filled-in template.
 * @throws UnresolvedPlaceholderError when a placeholder had no value.
 */
export function substitutePlaceholders(template: string, values: Record<string, string>): string {
  const table = new Map(Object.entries(values));
  const rendered = template.replaceAll(placeholderPattern(), (match: string, name: string) => {
    return table.get(name) ?? match;
  });

  const survivors = [...rendered.matchAll(placeholderPattern())].map((match) => match[0]);
  if (survivors.length > 0) {
    throw new UnresolvedPlaceholderError(survivors);
  }

  return rendered;
}

/**
 * The senses, as the markdown list the template expects.
 *
 * The sense id is written first and verbatim, because the model has to hand it
 * back on every object it returns. That id is what binds an answer to the row it
 * describes; a rewritten or prettified id would make the answer unattachable.
 */
function renderSenses(senses: PromptSense[]): string {
  return senses
    .map((sense) => {
      const glosses = sense.glosses.map((gloss) => `  - ${gloss}`).join('\n');
      const body = glosses === '' ? '  - (no gloss recorded)' : glosses;
      return `- Sense \`${sense.senseId}\`\n${body}`;
    })
    .join('\n');
}

/**
 * Render the enrichment prompt for one headword.
 *
 * This is where the markdown is read, on the first call and never again. It is
 * deliberately not read at module load, so importing this module cannot fail a
 * boot.
 *
 * @param params The headword, the direction, and the senses to write notes for.
 * @returns The prompt text to send to the model.
 * @throws PromptFileNotShippedError when the markdown is on none of the paths it
 *   is expected to be on, which means the image was built without it.
 * @throws UnresolvedPlaceholderError when the template holds a placeholder this
 *   function does not fill, which means the markdown and this file have drifted.
 */
export function renderEnrichmentPrompt(params: RenderEnrichmentPromptParams): string {
  return substitutePlaceholders(loadTemplate(), {
    lemma: params.lemma,
    pos: params.pos ?? POS_NOT_RECORDED,
    fromLanguageName: LANGUAGE_NAMES[params.from],
    toLanguageName: LANGUAGE_NAMES[params.to],
    senses: renderSenses(params.senses),
  });
}
