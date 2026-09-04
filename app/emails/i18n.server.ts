/**
 * i18n.server.ts, a request-safe `t` for code that has only a language code.
 *
 * The mail templates take a translator, not a language. A route already has
 * one from `useTranslation` or from its loader, but a background job, a CLI
 * command or a queued send has nothing but the code it stored, and the obvious
 * shortcut for those callers, importing the app's i18next singleton and
 * calling `i18next.changeLanguage(lng)`, is a real bug on the server: that
 * instance is one process-wide object shared by every in-flight request, so
 * whichever language was set last is the language the next mail is written in.
 *
 * So each language gets its OWN i18next instance here, built once and cached.
 * Two callers in two languages get two translators, always, and neither can
 * disturb the other. `init` is synchronous here because the catalogs are inline
 * imports rather than a runtime fetch, so `t` is usable the moment it returns.
 *
 * Only `common` is registered: mail copy lives there, and the `legal`
 * namespace is page prose no mail quotes.
 */
import i18next, { type TFunction } from 'i18next';

import { DEFAULT_LANGUAGE, isLanguageCode, type LanguageCode } from '#app/i18n/language-prefs';

import enCommon from '../locales/en/common.json';
import deCommon from '../locales/de/common.json';

/** The catalogs a mail may be written from, the same bundles the UI renders. */
const RESOURCES = {
  en: { common: enCommon },
  de: { common: deCommon },
} satisfies Record<LanguageCode, { common: typeof enCommon }>;

/** One instance per language, built on first use. */
const translators = new Map<LanguageCode, TFunction>();

/**
 * A translator for one language.
 *
 * An unsupported or missing code falls back to `DEFAULT_LANGUAGE`, the app's
 * single fallback constant, rather than to a second default of this module's
 * own. The value ultimately comes from a cookie, so it must degrade instead of
 * throwing while a verification mail is being written.
 *
 * @param lng - a language code, e.g. the one the request resolved.
 * @returns i18next's `t`, bound to that language.
 */
export function getServerT(lng: string | null | undefined): TFunction {
  const language: LanguageCode = isLanguageCode(lng) ? lng : DEFAULT_LANGUAGE;

  const cached = translators.get(language);
  if (cached !== undefined) return cached;

  const instance = i18next.createInstance();
  void instance.init({
    lng: language,
    fallbackLng: DEFAULT_LANGUAGE,
    resources: RESOURCES,
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
  });

  translators.set(language, instance.t);
  return instance.t;
}
