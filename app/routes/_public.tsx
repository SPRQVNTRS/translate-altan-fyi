import { Outlet, isRouteErrorResponse, useRouteError, Link } from 'react-router';
import PublicWrapper from '#app/components/public-wrapper';

export default function PublicLayout() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <PublicWrapper>
        <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
          <h1 className="text-6xl font-bold text-zinc-900 dark:text-zinc-100">404</h1>
          <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
            The page you&apos;re looking for doesn&apos;t exist.
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            &larr; Back to home
          </Link>
        </div>
      </PublicWrapper>
    );
  }

  return (
    <PublicWrapper>
      <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
        <h1 className="text-3xl font-bold text-red-600 dark:text-red-400">
          Something Went Wrong
        </h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          An unexpected error occurred.
        </p>
        {import.meta.env.DEV && error instanceof Error && (
          <pre className="mt-4 max-w-full overflow-auto rounded bg-zinc-100 p-4 text-left text-sm dark:bg-zinc-800">
            {error.message}
          </pre>
        )}
        <Link
          to="/"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
        >
          &larr; Back to home
        </Link>
      </div>
    </PublicWrapper>
  );
}
