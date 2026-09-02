/**
 * I18nProvider.tsx bridges the cookie-resolved language (root loader data)
 * into react-i18next for both the server render and the client hydration.
 *
 * `i18n` (./i18n.ts) is a MODULE-SCOPED SINGLETON, one per Node process, shared
 * by every concurrent request that process serves. Calling
 * `i18n.changeLanguage()` during a server render would leak one request's
 * locale into whichever other request renders next, so the two sides are
 * handled differently:
 *
 *   - SERVER: each render gets its own `i18n.cloneInstance({ lng })`. The clone
 *     shares the already-parsed resource store (no re-parsing the locale JSON
 *     per request) but owns its `language`/`resolvedLanguage`, so nothing it
 *     does is visible to another request or to the singleton. Passing `lng`
 *     explicitly also means the clone's detector never runs, moot on the server
 *     anyway, where there is no `document`.
 *
 *   - CLIENT: one browser tab per instance, so mutating the singleton is safe.
 *     It is synced INLINE during render, not in a `useEffect`, because an
 *     effect runs a tick too late, after a mismatched first paint has already
 *     committed. `changeLanguage()` resolves synchronously because both bundles
 *     are inline ESM imports.
 *
 * In practice the client sync is a no-op: the singleton's detector reads the
 * same cookie the server's loader did, and a language change reloads the
 * document rather than switching live. It stays as a belt-and-braces guard for
 * the one case where they could drift, a cookie written between the server
 * render and hydration.
 */
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import i18n from './i18n';
import { DEFAULT_LANGUAGE, type LanguageCode } from './language-prefs';

export function I18nProvider({
  language,
  children,
}: {
  /** Locale resolved server-side from the cookie, authoritative on first paint. */
  language?: LanguageCode | null;
  children: ReactNode;
}) {
  const isServer = globalThis.document === undefined;
  const resolved: LanguageCode = language ?? DEFAULT_LANGUAGE;

  if (!isServer && language && i18n.language !== language) {
    void i18n.changeLanguage(language);
  }

  const instance = isServer ? i18n.cloneInstance({ lng: resolved }) : i18n;

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
