/**
 * i18n.ts, the shared i18next singleton.
 *
 * Both locale bundles are inline ESM imports, so they are part of the app
 * bundle: no runtime fetch, no async loading state, and, the reason it matters
 * here, the PWA keeps working fully offline in either language without a
 * separate cache entry for the translations.
 *
 * ONE namespace. `common` is the whole UI and is loaded on every page. A second
 * namespace earns its place when a route carries enough prose that dragging it
 * into every page's bundle is wasteful, and no route here does yet.
 *
 * Detection is pinned to the COOKIE ONLY. The server renders from that same
 * cookie and nothing else (see `app/i18n/language-prefs.ts`), so any additional
 * client-side source could resolve to a different language than the markup
 * being hydrated. `caches` is empty for the same reason: writing the preference
 * is the picker's job (`selectLanguage`), and it is followed by a full reload,
 * so the detector must never quietly persist a guess of its own.
 */
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { DEFAULT_LANGUAGE, LANGUAGE_COOKIE, SUPPORTED_LANGUAGES } from './language-prefs';
import enCommon from '../locales/en/common.json';
import deCommon from '../locales/de/common.json';

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      de: { common: deCommon },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    defaultNS: 'common',
    ns: ['common'],
    detection: {
      order: ['cookie'],
      lookupCookie: LANGUAGE_COOKIE,
      caches: [],
    },
    interpolation: {
      // React escapes for us.
      escapeValue: false,
    },
    react: {
      // Nothing loads asynchronously (see the module doc), so there is never a
      // suspending moment to fall back from.
      useSuspense: false,
    },
  });

export default i18next;
