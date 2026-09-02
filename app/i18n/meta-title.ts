/**
 * meta-title.ts, translating a route's `<title>` without the i18next singleton.
 *
 * `meta()` runs OUTSIDE the React tree: there is no provider, no hook, no `t`.
 * The obvious shortcut, importing `#app/i18n/i18n` and calling `i18next.t(...)`,
 * is a real bug on the server, because that singleton is one process-wide
 * instance shared by every in-flight request. Whichever language the last
 * request happened to set is the language the next request's `<title>` would be
 * rendered in. Under any concurrency at all, that serves one visitor's language
 * inside another visitor's document.
 *
 * So this module is the seam: a PURE `(language, key) -> string` lookup over
 * the two statically-imported catalogs. No singleton, no `init`, no mutable
 * state, nothing to leak between requests, so two callers on two requests with
 * two languages get two answers, always. It is also trivially unit-testable,
 * which the singleton path was not.
 *
 * The language itself comes from the ROOT loader, which already resolves it
 * from the request cookie (see `app/root.tsx`). `meta()` receives `matches`, so
 * `metaLanguage(matches)` reads it back out of the root match: request-scoped
 * data travelling through request-scoped plumbing, never module state.
 *
 * Usage in a route:
 *
 * ```ts
 * export const meta: MetaFunction = ({ matches }) => [
 *   { title: metaTitle(metaLanguage(matches), 'search.metaTitle') },
 * ];
 * ```
 */
import { z } from 'zod';
import { DEFAULT_LANGUAGE, isLanguageCode, type LanguageCode } from './language-prefs';
import enCommon from '../locales/en/common.json';
import deCommon from '../locales/de/common.json';

/** A translation catalog: nested objects bottoming out in strings. */
type Catalog = { readonly [key: string]: string | Catalog };

/**
 * Both shipped catalogs, keyed by language. Static imports, the same bundles
 * `i18n.ts` feeds i18next, so a title can never drift from the rest of the UI.
 */
const CATALOGS = {
  en: enCommon,
  de: deCommon,
} satisfies Record<LanguageCode, Catalog>;

/** The root route's id, as registered by React Router for `app/root.tsx`. */
const ROOT_ROUTE_ID = 'root';

/**
 * The one field `metaLanguage` reads off the root loader's data. Parsed rather
 * than asserted because `loaderData` genuinely arrives unvalidated: an error
 * boundary can run `meta()` with no loader data at all, so anything that is not
 * an object carrying a language string must degrade to the default.
 */
const RootLanguageLoaderDataSchema = z.object({ language: z.string().nullish() });

/** Narrows any language-ish value to a supported code. */
function toLanguageCode(language: string | null | undefined): LanguageCode {
  return isLanguageCode(language) ? language : DEFAULT_LANGUAGE;
}

/** A catalog node is a nested catalog rather than a leaf translation string. */
function isNestedCatalog(node: string | Catalog): node is Catalog {
  return node instanceof Object;
}

/** Walks a dotted key through a catalog. Returns `undefined` for a miss or a non-leaf. */
function lookup(catalog: Catalog, key: string): string | undefined {
  let node: string | Catalog | undefined = catalog;
  for (const part of key.split('.')) {
    if (node === undefined || !isNestedCatalog(node)) return undefined;
    node = node[part];
  }
  return node === undefined || isNestedCatalog(node) ? undefined : node;
}

/**
 * The shape `metaLanguage` needs off a `MetaArgs['matches']` entry. Declared
 * structurally rather than imported from React Router so this module stays a
 * plain, framework-free unit under `node:test`, and so every route's generated
 * `Route.MetaArgs` (each with its own match union) can pass its `matches`
 * straight in. React Router types a match slot as possibly `undefined` (a
 * `meta()` can run for a match that never resolved), so the array is accepted
 * as sparse rather than forcing every call site to pre-filter it.
 */
export type MetaLanguageMatch = {
  readonly id: string;
  readonly loaderData?: unknown;
};

/**
 * The UI language for this request, read off the ROOT loader's `language`.
 *
 * Falls back to the default whenever the root match is absent or its data is
 * not what we expect. An error boundary can render `meta()` with no loader data
 * at all, and the language ultimately originates in a non-httpOnly cookie, so a
 * bad value must degrade to an English title rather than throw and blank the
 * document head.
 *
 * @param matches - the `matches` array `meta()` is called with.
 * @returns the active language code.
 */
export function metaLanguage(matches: readonly (MetaLanguageMatch | undefined)[] | undefined): LanguageCode {
  const root = matches?.find((match) => match?.id === ROOT_ROUTE_ID);
  const parsed = RootLanguageLoaderDataSchema.safeParse(root?.loaderData);
  return parsed.success ? toLanguageCode(parsed.data.language) : DEFAULT_LANGUAGE;
}

/** Fills i18next-style `{{name}}` placeholders. An unsupplied name is left in place, exactly as i18next leaves it. */
function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}

/**
 * The pure `(language, key) -> string` lookup itself, for callers that are not
 * a `<title>`.
 *
 * `meta()` is not the only place that must translate outside the React tree. A
 * pure formatting helper has no hook either, and reaching for the singleton
 * there is the same cross-request bug this module exists to avoid. Such a
 * helper takes the language as a parameter and comes through here.
 *
 * Resolution order mirrors i18next's own: the requested language, then English
 * as `fallbackLng`, then the key itself, a visible-but-harmless last resort,
 * the same thing i18next renders for an unknown key, and never a thrown error
 * in the document head. A caller that needs to DETECT a miss can compare the
 * result against the key it passed.
 *
 * @param language - the active language, e.g. `i18n.language` or a stored code.
 * @param key - a dotted catalog key, e.g. `'search.metaTitle'`.
 * @param values - `{{name}}` interpolation values, as i18next's `t` takes them.
 * @returns the translated string.
 */
export function translateStatic(
  language: string | null | undefined,
  key: string,
  values: Readonly<Record<string, string>> = {},
): string {
  const template = lookup(CATALOGS[toLanguageCode(language)], key) ?? lookup(CATALOGS[DEFAULT_LANGUAGE], key) ?? key;
  return interpolate(template, values);
}

/**
 * Translates a document `<title>` (or any other meta string) purely, a thin
 * naming of `translateStatic` for the `meta()` call sites this module was
 * written for.
 *
 * @param language - the active language, e.g. from `metaLanguage(matches)`.
 * @param key - a dotted catalog key, e.g. `'search.metaTitle'`.
 * @returns the translated string.
 */
export function metaTitle(language: string | null | undefined, key: string): string {
  return translateStatic(language, key);
}
