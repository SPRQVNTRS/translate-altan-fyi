/**
 * i18n.ts, the shared i18next singleton.
 *
 * Both locale bundles are inline ESM imports, so they are part of the app
 * bundle: no runtime fetch, no async loading state, and, the reason it matters
 * here, the PWA keeps working fully offline in either language without a
 * separate cache entry for the translations.
 *
 * TWO namespaces. `common` is the whole UI and is loaded on every page. `legal`
 * is the second, and it earned its place the way the rule above says one has
 * to: the imprint, privacy and terms pages carry more prose than the rest of
 * the app put together, none of it is read on any other screen, and a
 * translation run over the legal documents must not be able to disturb a nav
 * label. Route components ask for it explicitly with `useTranslation('legal')`.
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
import enLegal from '../locales/en/legal.json';
import deLegal from '../locales/de/legal.json';

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, legal: enLegal },
      de: { common: deCommon, legal: deLegal },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    defaultNS: 'common',
    ns: ['common', 'legal'],
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
