/**
 * language-pair.ts, the language pair the translator screen is set to.
 *
 * WHAT THIS REPLACES, AND WHY IT EXISTS AT ALL. The screen used to guess the
 * source language on every submission and offer a "flip" link beside the
 * guess. Tapping that link pinned `from` and `to` into every LATER submission,
 * because the pane wrote them into hidden inputs whenever the direction was
 * not detected. One tap therefore searched the wrong side of the dictionary
 * for every word typed afterwards, silently: a German word looked up with
 * `from=en` returns nothing and says nothing about why. The operator hit that
 * in production. The pair is an explicit, visible, persisted control now, and
 * this module is the whole of what "the pair" means.
 *
 * THE SOURCE MAY BE `detect`, THE TARGET MAY NOT. Detection is a real choice a
 * reader makes, so it is a value of the source selection rather than the
 * absence of one. There is nothing to detect on the target side: a translation
 * has to land somewhere, and the reader is the only one who knows where.
 *
 * WHY A COOKIE WHEN THE DEVICE STORE IS TINYBASE. TinyBase is IndexedDB:
 * asynchronous and client-only. The server renders the language bar in the
 * first byte of HTML, so without a server-readable mirror the bar paints the
 * default pair and then jumps to the stored one after hydration. TinyBase
 * (`app/lib/local-store/language-pair.ts`) is the durable store; the cookie is
 * the SSR mirror, and both are written whenever the pair changes so the two
 * cannot drift. That is the identical arrangement `app/i18n/language-prefs.ts`
 * uses for the UI locale, and for the identical reason.
 *
 * NOT httpOnly: the client writes it, no server action ever does.
 *
 * Client- and server-safe: plain TS, no server-only imports, no `document`
 * access at module scope. The client helper guards `document` itself, so this
 * file is import-safe under SSR.
 */

import type { LanguageCode } from './detect-language';

/**
 * The source selection that means "work it out from the query".
 *
 * It is also the literal this value travels the URL as. `chooseDirection` in
 * `detect-language.ts` ignores any `from` that is not one of the four served
 * languages and falls through to detection, which was read end to end on
 * 2026-09-04 to confirm it: `isServedLanguage(input.from) ? input.from : null`,
 * then the exact-hit count, then the character heuristic. So `from=detect`
 * needs no special case on the server, and adding one would be a second place
 * the meaning of "detect" could drift.
 */
export const DETECT = 'detect';

/** What the source side of the pair can be: one served language, or detection. */
export type SourceSelection = typeof DETECT | LanguageCode;

/** The pair the translator screen is set to. */
export interface LanguagePair {
  source: SourceSelection;
  target: LanguageCode;
}

/** Where the pair is mirrored for the server to read on the first byte of HTML. */
export const LANGUAGE_PAIR_COOKIE = 'translate-pair';

/**
 * The pair a device with no stored preference starts on.
 *
 * Detection on the source side, because a first-time reader has told us
 * nothing about what they will type, and German on the target side, because
 * this dictionary is built around the German and English pair and German is
 * the side the product's readers are learning.
 */
export const DEFAULT_PAIR: LanguagePair = { source: DETECT, target: 'de' };

/**
 * Native display names, one per served language.
 *
 * THE SINGLE SOURCE OF TRUTH FOR WHAT A LANGUAGE IS CALLED. `VOICE_LANGUAGES`
 * in `app/components/voice-input.tsx` derives its own labels from this table
 * rather than repeating them: a language named twice in two files is a
 * language that will eventually be named two different ways.
 *
 * A language is always named in its own language and never translated, so a
 * reader can find their own in a list they cannot otherwise read. That is the
 * same rule `LANGUAGE_LABELS` in `app/i18n/language-prefs.ts` follows for the
 * interface locale.
 */
export const LANGUAGE_NAMES = {
  en: 'English',
  de: 'Deutsch',
  tr: 'Türkçe',
  es: 'Español',
} satisfies Record<LanguageCode, string>;

/** 1 year, a durable per-device preference, like the theme and the interface language. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * The served languages, in the order the bar offers them.
 *
 * IT IS WRITTEN OUT HERE RATHER THAN IMPORTED FROM `SERVED_LANGUAGES`, and the
 * reason is the bundle, not taste. `detect-language.ts` imports the Drizzle
 * schema at module scope, and this module is loaded by the browser, so a VALUE
 * import from there would pull the database layer and the workflow package
 * into the client bundle. Only the TYPE is imported above, which erases.
 *
 * TWO THINGS KEEP THE COPY HONEST. `satisfies` makes every entry here a real
 * served language, so a language this dictionary does not serve cannot be
 * offered, and `tests/unit/language-pair.test.ts` asserts this list and
 * `SERVED_LANGUAGES` hold exactly the same codes, which is the half the type
 * system cannot see.
 */
export const PAIR_LANGUAGES = ['en', 'de', 'tr', 'es'] as const satisfies readonly LanguageCode[];

const PAIR_LANGUAGE_SET: ReadonlySet<string> = new Set(PAIR_LANGUAGES);

/** Whether a URL, cookie or store value names one of the served languages. */
export function isPairLanguage(value: string | null | undefined): value is LanguageCode {
  return value !== null && value !== undefined && PAIR_LANGUAGE_SET.has(value);
}

/** Whether a URL, cookie or store value names a source the bar can be set to. */
export function isSourceSelection(value: string | null | undefined): value is SourceSelection {
  return value === DETECT || isPairLanguage(value);
}

/**
 * The other side of a pair, when the two sides have collided.
 *
 * IT MIRRORS `partnerOf` IN `detect-language.ts` RATHER THAN IMPORTING IT, and
 * the duplication is deliberate: that module imports the Drizzle schema at
 * module scope, so a value import from here would pull the database layer into
 * the browser bundle. Only the TYPE is imported above, which erases. The rule
 * itself is one line and is stated in both places, and
 * `tests/unit/language-pair.test.ts` pins this copy of it.
 */
function partnerLanguage(language: LanguageCode): LanguageCode {
  return language === 'en' ? 'de' : 'en';
}

/**
 * The pair to hand the bar once a search has actually run, reconciled against
 * the direction that search used.
 *
 * `direction` IS THE ONLY AUTHORITY ON WHAT THE SEARCH DID. `resolveLanguagePair`
 * repairs a target that collides with a STATED source, but that repair cannot
 * see every collision: `from=detect` states no source at all, so nothing
 * collides at resolve time, and `chooseDirection` can still send the search to
 * a target the pair never mentioned once detection settles on a source. A
 * browser walk on 2026-09-04 found exactly this: `?from=detect&to=de` showed
 * "Deutsch" on the bar while every result carried `?to=en`, because the query
 * was German and `chooseDirection` repaired `to` to English, a repair the pair
 * above never learned about. Handing the bar anything other than
 * `direction.to` is how a label comes to disagree with its own results.
 *
 * THE SOURCE STAYS THE READER'S OWN STATEMENT, `detect` included. The bar
 * renders the detected language as the `(Deutsch)` suffix off `direction.from`,
 * and it needs `source` to still read `detect` to know that suffix names a
 * detection rather than a language the reader pinned.
 *
 * There is no search to reconcile against on the empty-query branch: nothing
 * has run, so nothing has produced a target to disagree with, and this
 * function must not be called there.
 */
export function reconcilePairWithDirection(pair: LanguagePair, direction: { to: LanguageCode }): LanguagePair {
  return { source: pair.source, target: direction.to };
}

/**
 * The pair, as one cookie value: `"<source>:<target>"`, for example `detect:de`.
 *
 * Two codes and a colon rather than JSON, because a cookie value is read by a
 * hand-written parser on the server and a shape with no quoting rules is a
 * shape that cannot be half-parsed.
 */
export function serializeLanguagePair(pair: LanguagePair): string {
  return `${pair.source}:${pair.target}`;
}

/** Read one named cookie out of a raw `Cookie` header. Mirrors `language-prefs.ts`. */
function readCookieFromHeader(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * SERVER: the pair mirrored in this request's cookies, or `null`.
 *
 * Never throws. Anything unparseable, and anything naming a language this
 * dictionary does not serve, reads as `null` rather than as a bad pair: a
 * stale cookie from a removed language must fall back to the default, not
 * search a side of the dictionary that no longer exists.
 *
 * @param header - the request's raw `Cookie` header, or `null`.
 */
export function parseLanguagePairCookie(header: string | null): LanguagePair | null {
  const raw = readCookieFromHeader(header, LANGUAGE_PAIR_COOKIE);
  if (raw === undefined) return null;
  const [source, target] = raw.split(':');
  if (!isSourceSelection(source)) return null;
  if (!isPairLanguage(target)) return null;
  return { source, target };
}

/** What `resolveLanguagePair` reads: the two URL parameters and the cookie header. */
export interface ResolveLanguagePairParams {
  from: string | null;
  to: string | null;
  cookieHeader: string | null;
}

/**
 * The pair this request renders with.
 *
 * PRECEDENCE, HIGHEST FIRST, AND IT IS APPLIED PER SIDE:
 *   1. The URL. `from` and `to` as they arrived, `detect` included.
 *   2. The cookie, which mirrors what this device last chose.
 *   3. {@link DEFAULT_PAIR}.
 *
 * THE URL WINS BECAUSE A RESULT URL IS A PLACE. A shared or bookmarked link
 * has to render the pair it was captured with, not the pair the device
 * opening it happens to prefer, or the recipient reads an answer under a
 * heading that describes a different question. The device preference is what
 * fills in what the link did not say, which is what makes a bare `/translate`
 * open on the reader's own pair.
 *
 * A TARGET EQUAL TO THE RESOLVED SOURCE IS REPAIRED, not honoured. A
 * translation is an edge between two DIFFERENT languages, so `de -> de` names
 * no edge that exists. `chooseDirection` makes the same repair on the query
 * itself, and making it here as well is what stops the bar from displaying a
 * target the search did not actually use.
 */
export function resolveLanguagePair(params: ResolveLanguagePairParams): LanguagePair {
  const cookiePair = parseLanguagePairCookie(params.cookieHeader);
  const source = isSourceSelection(params.from) ? params.from : (cookiePair?.source ?? DEFAULT_PAIR.source);
  const statedTarget = isPairLanguage(params.to) ? params.to : (cookiePair?.target ?? DEFAULT_PAIR.target);
  const target = statedTarget === source ? partnerLanguage(statedTarget) : statedTarget;
  return { source, target };
}

/**
 * CLIENT: mirror the pair into the cookie, so the next request's first byte of
 * HTML already carries it. No-op on the server.
 *
 * 1 year, `path=/`, `SameSite=Lax`, and not httpOnly, exactly as the interface
 * locale's cookie is written and for the same reason: the client is the only
 * thing that ever writes it.
 */
export function writeLanguagePairCookie(pair: LanguagePair): void {
  if (globalThis.document === undefined) return;
  document.cookie = `${LANGUAGE_PAIR_COOKIE}=${serializeLanguagePair(pair)}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * The four served languages with their native names, in the order the bar
 * offers them. Derived from {@link PAIR_LANGUAGES} and
 * {@link LANGUAGE_NAMES}, so the bar cannot offer a language with no name and
 * cannot name a language it does not offer.
 */
export const LANGUAGE_OPTIONS = PAIR_LANGUAGES.map((code) => ({
  code,
  name: LANGUAGE_NAMES[code],
}));
