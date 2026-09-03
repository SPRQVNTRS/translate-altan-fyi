import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * The Matomo tag, rendered on the production host only.
 *
 * Matomo runs on our own server at `matomo.sprqvntrs.com`, so no visit is
 * reported to an analytics company. Three calls before `trackPageView` are what
 * make this page free of a consent banner and true to the privacy policy:
 *
 *   - `disableCookies`: the tracker sets no cookie and stores nothing on the
 *     device, so there is no access to terminal equipment to ask consent for.
 *   - `setDoNotTrack`: a browser that sends the Do Not Track header is not
 *     counted at all.
 *   - `setCustomUrl` with the PATH ONLY. This one is not cosmetic. A results
 *     page is `/?q=Feierabend`, so reporting the real URL would file every
 *     lookup in an analytics database, and the privacy page states that Matomo
 *     is never told what you searched for. The referrer is trimmed the same way,
 *     because the page a reader arrived from is usually their own last search.
 *
 * This app has no consent state and no cookie banner, which is why the
 * consent-manager hooks in the nicotinepouch version of this component are not
 * carried across. Adding a cookie here would need both back.
 *
 * `ANALYTICS_ENABLED` in `app/routes/legal/privacy.tsx` is true because this
 * component exists. Removing the tag means flipping that constant back.
 */

/**
 * The Matomo site id for `translate.altan.fyi`, registered in djinn's site map
 * under the `translate` alias.
 *
 * Written as a literal inside the snippet below rather than interpolated: an id
 * that only appears after string interpolation is exactly the kind of value
 * that silently becomes `undefined`, and a launch check greps `app/` for it
 * next to `setSiteId`.
 */
export const MATOMO_SITE_ID = '19';

const MATOMO_SNIPPET = `
  var _paq = window._paq = window._paq || [];
  _paq.push(['disableCookies']);
  _paq.push(['setDoNotTrack', true]);
  _paq.push(['setCustomUrl', location.origin + location.pathname]);
  if (document.referrer) _paq.push(['setReferrerUrl', document.referrer.split('?')[0]]);
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  (function() {
    var u="//matomo.sprqvntrs.com/";
    _paq.push(['setTrackerUrl', u+'matomo.php']);
    _paq.push(['setSiteId', '19']);
    var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
    g.async=true; g.src=u+'matomo.js'; s.parentNode.insertBefore(g,s);
  })();
`;

/** The tracker snippet, for the document head. The caller decides which host may render it. */
export function Matomo() {
  return <script defer dangerouslySetInnerHTML={{ __html: MATOMO_SNIPPET }} />;
}

/** The queue the snippet above installs on `window`. */
type TrackerQueue = { push: (command: unknown[]) => void };

/** Reads the tracker queue, or null when the snippet has not run in this document. */
function trackerQueue(): TrackerQueue | null {
  // SAFETY: `_paq` is an array the snippet above puts on `window`, and the
  // property is read as optional, so a document where the snippet never ran
  // reads `undefined` and this returns null.
  const queue = (globalThis as { _paq?: TrackerQueue })._paq;
  return queue ?? null;
}

/**
 * A page view per client-side navigation.
 *
 * This is a single-page app: after the first document, every screen change is a
 * router transition and the snippet above never runs again. Without this the
 * whole product would report as one page, so the numbers would say nothing
 * about which screens people use.
 *
 * It renders nothing, and it deliberately skips the FIRST location it sees,
 * which the snippet has already counted. The path travels without its query
 * string for the reason given at the top of this file.
 */
export function MatomoRouteTracker() {
  const location = useLocation();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;
    // The snippet counted the document this component mounted in. Recording it
    // again here would double every landing.
    if (lastPath.current === null) {
      lastPath.current = path;
      return;
    }
    // A query-only change (a new search on the same screen) is not a new page.
    if (lastPath.current === path) return;
    const queue = trackerQueue();
    if (queue === null) return;
    const origin = globalThis.location.origin;
    queue.push(['setReferrerUrl', `${origin}${lastPath.current}`]);
    queue.push(['setCustomUrl', `${origin}${path}`]);
    queue.push(['trackPageView']);
    lastPath.current = path;
  }, [location.pathname]);

  return null;
}
