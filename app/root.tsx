import '@fontsource-variable/inter';
import '@fontsource-variable/victor-mono';
import { useEffect } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteLoaderData,
  redirect,
} from 'react-router';
import type { Route } from './+types/root';
import { getToast } from '#app/utils/toast.server';
import { sessionStorage } from '#app/services/session.server';
import stylesheet from './app.css?url';
import { combineHeaders } from '#app/utils/misc';
import { Toaster } from '#app/components/ui/toaster';
import { useToast } from '#app/hooks/use-toast';
import { LoadingProvider } from '#app/context/loading';
import { reportError } from '#app/lib/report-error';
import { I18nProvider } from '#app/i18n/I18nProvider';
import {
  DEFAULT_LANGUAGE,
  readLanguageCookie,
  readStoredLanguage,
  resolveRequestLanguage,
  type LanguageCode,
} from '#app/i18n/language-prefs';
import { shouldFallbackOffline } from '#app/lib/local-store';
import { isAnalyticsHost } from '#app/lib/analytics-host';
import { Matomo, MatomoRouteTracker } from '#app/components/site/matomo';

// The two variable body faces are self-hosted through fontsource, so the app
// makes no request to a third-party font host. Fraunces, the display face, is
// declared as an `@font-face` in `app.css` over a file in `public/fonts`.
export const links: Route.LinksFunction = () => [
  { rel: 'stylesheet', href: stylesheet },
  // The two PWA links. The manifest is what makes the app installable, and the
  // apple-touch-icon is the only icon iOS reads, it ignores the manifest's own
  // icon list entirely.
  { rel: 'manifest', href: '/manifest.webmanifest' },
  { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
];

export async function loader({ request }: Route.LoaderArgs) {
  const { pathname, search } = new URL(request.url);
  if (pathname.endsWith('/') && pathname !== '/') {
    // Redirect to the same URL without a trailing slash
    return redirect(`${pathname.slice(0, -1)}${search}`, 301);
  }

  const { toast, headers: toastHeaders } = await getToast(request);

  // Check for user session (optional - don't redirect)
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  // The session stores a SessionUser; deactivation is re-checked against the
  // database by `authMiddleware` on every authenticated route.
  const user = session.get('user') ?? null;

  // The UI locale is a device preference, so it is read straight off the
  // cookie, never the database: `<html lang>` is then correct in the very first
  // byte of HTML without costing this hot path a round trip. See
  // `app/i18n/language-prefs.ts` for why the cookie is the only server signal,
  // and the boot script in `Layout` for what happens on a first visit, when
  // there is no cookie to read yet.
  const language = resolveRequestLanguage(request.headers.get('cookie'));

  // WHETHER THIS HOST COUNTS VISITS, decided on the server so the tag is in the
  // first byte of HTML rather than appearing after hydration. Behind Traefik
  // the browser's host arrives in `X-Forwarded-Host`; direct, it is `Host`.
  // Stage and localhost fall through both and render no tag at all.
  const isAnalyticsEnabled = isAnalyticsHost(request.headers.get('x-forwarded-host') ?? request.headers.get('host'));

  return {
    toast,
    user,
    language,
    isAnalyticsEnabled,
    headers: combineHeaders(toastHeaders),
  };
}

/** Exactly what `serverLoader()` hands back, so the offline answer cannot drift from the loader above. */
type RootData = Awaited<ReturnType<Route.ClientLoaderArgs['serverLoader']>>;

/**
 * The last root payload the server actually answered with. Module scope, so it
 * survives every navigation within the tab and is discarded on a real reload,
 * which is when the server is asked again anyway.
 */
let lastServedRootData: RootData | null = null;

/**
 * The root loader's `headers` field as the CLIENT sees it. Single fetch cannot
 * serialize methods, so a `Headers` instance arrives as an object whose every
 * method is `undefined`. This value is what an empty one looks like: nothing to
 * set, which is the truth offline, where no cookie is being handed back.
 */
const NO_SERIALIZED_HEADERS = {
  append: undefined,
  delete: undefined,
  get: undefined,
  getSetCookie: undefined,
  has: undefined,
  set: undefined,
  forEach: undefined,
  [Symbol.iterator]: undefined,
  entries: undefined,
  keys: undefined,
  values: undefined,
} satisfies RootData['headers'];

/**
 * Offline survival for the root route, and through it for every client-only
 * mutation in the app.
 *
 * The lists, history and notes screens write through a `clientAction`, so the
 * write itself never touches the network. React Router still REVALIDATES after
 * every action, and because this route has a server `loader`, that revalidation
 * issues a single-fetch `/<path>.data` request for the whole route tree.
 * `public/sw.js` never caches `.data` BY DESIGN, not by oversight: a cached
 * loader response would be served as a live answer, and this app must never
 * present a stale translation as a current one. Offline that fetch therefore
 * rejects with a `TypeError`, and before this `clientLoader` existed nothing
 * caught it, so the root error boundary replaced a page whose own write had
 * ALREADY SUCCEEDED on the device.
 *
 * Only a NETWORK failure is absorbed. `shouldFallbackOffline` returns true for
 * an offline navigator or a `TypeError` and nothing else, so an application
 * error still reaches the boundary: the trailing-slash `redirect` the server
 * loader throws, a 500, any thrown `Response`. Swallowing those would render a
 * silently wrong page, which is worse than the crash this replaces.
 *
 * `clientLoader.hydrate` is deliberately NOT set. The default reuses the
 * server-rendered root data on hydration, so a cold load costs no extra fetch.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs): Promise<RootData> {
  try {
    const data = await serverLoader();
    lastServedRootData = data;
    return data;
  } catch (cause) {
    if (!shouldFallbackOffline(cause)) throw cause;
    if (lastServedRootData) return lastServedRootData;
    // First run offline: the shell came from the service worker cache and this
    // loader has never seen a server answer. `user` and `toast` are unknowable
    // without the server, so they are null rather than invented. The language
    // is a device preference, so the client already holds it, in the cookie
    // with a localStorage mirror.
    return {
      toast: null,
      user: null,
      language: readLanguageCookie() ?? readStoredLanguage() ?? DEFAULT_LANGUAGE,
      // Offline there is nothing to report and no tracker to report it to.
      isAnalyticsEnabled: false,
      headers: NO_SERIALIZED_HEADERS,
    };
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Read through `useRouteLoaderData` rather than `useLoaderData`: `Layout`
  // also wraps the root ErrorBoundary, where this loader may never have run.
  // There is no data in that case and the default is the right answer.
  const rootData = useRouteLoaderData<typeof loader>('root');
  const language: LanguageCode = rootData?.language ?? DEFAULT_LANGUAGE;
  // No loader data means the root error boundary is rendering, which is not a
  // page view worth counting, so the tag stays off.
  const isAnalyticsEnabled = rootData?.isAnalyticsEnabled ?? false;

  return (
    <html lang={language} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Brand-tints the browser chrome on mobile and in the installed app. */}
        <meta name="theme-color" content="#057a78" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                function applyTheme() {
                  var theme = localStorage.getItem('theme');
                  var isDark = theme === 'dark' || (!theme || theme === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches;
                  document.documentElement.classList.toggle('dark', isDark);
                }
                applyTheme();
                window.__applyTheme = applyTheme;
                window.__getStoredTheme = function() {
                  return localStorage.getItem('theme') || 'system';
                };
              })();
            `,
          }}
        />
        {/* First-visit language detection.
            The server can only read a cookie, so a visitor who has never been
            here is served the default language no matter what their browser
            asks for. This script runs before paint, derives the language from
            the browser, and persists it in BOTH stores so every later request
            is server-rendered correctly.

            The reload is the awkward part, and it is deliberate. The markup
            above it has already been produced in the served language, so
            without a reload the visitor would sit on a document whose chrome
            and content disagree. A half-translated page is worse than one extra
            reload on the very first visit, and only on the first visit: the
            sessionStorage flag means a browser that refuses our cookie can
            never turn this into a loop. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var KEY = 'translate-language';
                  var served = ${JSON.stringify(language)};
                  if (/(?:^|;\\s*)translate-language=/.test(document.cookie)) return;
                  var wanted = null;
                  try { wanted = localStorage.getItem(KEY); } catch (e) {}
                  if (wanted !== 'en' && wanted !== 'de') {
                    var tags = navigator.languages || [navigator.language || ''];
                    wanted = 'en';
                    for (var i = 0; i < tags.length; i++) {
                      var primary = String(tags[i]).toLowerCase().split('-')[0];
                      if (primary === 'en' || primary === 'de') { wanted = primary; break; }
                    }
                  }
                  document.cookie = KEY + '=' + wanted + '; path=/; max-age=31536000; SameSite=Lax';
                  try { localStorage.setItem(KEY, wanted); } catch (e) {}
                  if (wanted !== served && !sessionStorage.getItem('translate-language-probed')) {
                    sessionStorage.setItem('translate-language-probed', '1');
                    location.reload();
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
        {/* Production only. See `#app/lib/analytics-host`: stage and a laptop
            would otherwise be counted as real use of the product. */}
        {isAnalyticsEnabled && <Matomo />}
      </head>
      <body className="font-sans">
        <I18nProvider language={language}>{children}</I18nProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const loaderData = useLoaderData<typeof loader>();
  useToast(loaderData?.toast);

  // Register the service worker, production only. In dev the worker would sit
  // between Vite and the browser and serve a stale module graph, which reads as
  // "my edit did nothing" rather than as a caching bug. `import.meta.env.PROD`
  // is a build-time constant, so the whole branch is dropped from the dev
  // bundle. A registration failure (an unsupported browser, a blocked origin,
  // a private window) is swallowed: the app works without a worker, so it must
  // never take the page down with it.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);

  return (
    <LoadingProvider>
      {/* Every screen change after the first document is a router transition,
          which the head snippet cannot see. This renders nothing. */}
      {loaderData?.isAnalyticsEnabled && <MatomoRouteTracker />}
      <Outlet />
      {/* `system`, not a hardcoded `light`. The app has a class-based dark
          mode, so a fixed light value gave a dark-mode user a white toast on a
          dark page. */}
      <Toaster closeButton position="bottom-right" theme="system" />
    </LoadingProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      message = '404';
      details = 'The requested page could not be found.';
    } else {
      message = 'Error';
      details = error.statusText || details;
      reportError(error, { boundary: 'root', status: error.status });
    }
  } else {
    reportError(error, { boundary: 'root' });
    if (import.meta.env.DEV && error && error instanceof Error) {
      details = error.message;
      stack = error.stack;
    }
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
