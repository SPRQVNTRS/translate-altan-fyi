import { useRouteError, isRouteErrorResponse } from 'react-router';
import { reportError } from '#app/lib/report-error';

/**
 * Generic route error boundary component.
 * Use this in individual routes to prevent errors from bubbling up
 * to the layout error boundary during client-side navigation.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-red-600 dark:text-red-400">
          {error.status} {error.statusText}
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          {error.data?.message || 'An error occurred while loading this page.'}
        </p>
      </div>
    );
  }

  reportError(error, { boundary: 'route' });

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-red-600 dark:text-red-400">
        Something went wrong
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        An unexpected error occurred while loading this page.
      </p>
      {error instanceof Error && (
        <pre className="mt-4 overflow-auto rounded bg-zinc-100 p-4 text-sm dark:bg-zinc-800">
          {error.message}
        </pre>
      )}
    </div>
  );
}
