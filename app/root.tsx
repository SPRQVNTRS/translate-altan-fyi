import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
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

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap',
  },
  { rel: 'stylesheet', href: stylesheet },
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

  return {
    toast,
    user,
    headers: combineHeaders(toastHeaders),
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const loaderData = useLoaderData<typeof loader>();
  useToast(loaderData?.toast);
  return (
    <LoadingProvider>
      <Outlet />
      <Toaster closeButton position="bottom-right" theme={'light'} />
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
