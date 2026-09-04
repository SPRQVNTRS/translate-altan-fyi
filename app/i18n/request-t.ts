/**
 * A translator bound to ONE request's language.
 *
 * `app/i18n/meta-title.ts` explains why the i18next singleton must not be
 * called directly on the server: `i18next.t(...)` renders in whatever language
 * the last request happened to set, which under any concurrency serves one
 * visitor's language inside another visitor's document.
 *
 * `getFixedT` does not have that problem, and the difference is worth stating.
 * It returns a translator CLOSED OVER a language rather than reading the
 * instance's current one, and it mutates nothing, so two calls on two requests
 * with two languages give two answers. That is what the mail templates need:
 * they take a `t` and must render in the language the reader was using.
 */
import i18next from './i18n';
import { resolveRequestLanguage } from './language-prefs';
import type { TFunction } from 'i18next';

/**
 * The translator for this request.
 *
 * @param request the incoming request, read only for its language cookie.
 * @returns a `t` bound to the request's language and the `common` namespace.
 */
export function requestT(request: Request): TFunction {
  return i18next.getFixedT(resolveRequestLanguage(request.headers.get('cookie')), 'common');
}
