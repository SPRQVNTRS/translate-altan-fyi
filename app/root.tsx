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
import { DEFAULT_LANGUAGE, resolveRequestLanguage, type LanguageCode } from '#app/i18n/language-prefs';

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

  return {
    toast,
    user,
    language,
    headers: combineHeaders(toastHeaders),
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Read through `useRouteLoaderData` rather than `useLoaderData`: `Layout`
  // also wraps the root ErrorBoundary, where this loader may never have run.
  // There is no data in that case and the default is the right answer.
  const rootData = useRouteLoaderData<typeof loader>('root');
  const language: LanguageCode = rootData?.language ?? DEFAULT_LANGUAGE;

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
