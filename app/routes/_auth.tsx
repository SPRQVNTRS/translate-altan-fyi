import type { Route } from './+types/_auth';
import { Outlet, isRouteErrorResponse, useRouteError, Link } from 'react-router';
import { authMiddleware } from '#app/middleware/auth';
import { getUser } from '#app/middleware/helpers';

export const middleware = [authMiddleware];

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  return { user };
}

export default function AuthLayout() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();

  let message = 'Something went wrong';
  let details = 'An unexpected error occurred.';

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? 'Page Not Found' : `Error ${error.status}`;
    details = error.status === 404
      ? "The page you're looking for doesn't exist."
      : error.statusText || details;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">{message}</h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">{details}</p>
        {import.meta.env.DEV && error instanceof Error && (
          <pre className="mt-4 max-w-lg overflow-auto rounded bg-zinc-100 p-4 text-left text-sm dark:bg-zinc-800">
            {error.message}
          </pre>
        )}
        <Link
          to="/dashboard"
          className="mt-6 inline-block text-blue-600 hover:underline dark:text-blue-400"
        >
          &larr; Back to dashboard
        </Link>
      </div>
    </div>
  );
}
