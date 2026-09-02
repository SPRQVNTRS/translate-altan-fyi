import { z } from 'zod';
import type { Route } from './+types/_layout';
import { useMatches, Outlet, isRouteErrorResponse, useRouteError, useParams } from 'react-router';
import AppWrapper from '#app/components/app-wrapper';
import { tenantContext } from '#app/middleware/context';
import { reportError } from '#app/lib/report-error';


/** Route `handle` values are untyped by React Router; decode before reading. */
const baseHandleSchema = z
  .object({ title: z.string().optional(), backTo: z.string().optional() })
  .catch({});

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);

  return {
    tenant: tenant
      ? {
          orgId: tenant.orgId,
          orgSlug: tenant.orgSlug,
          orgRole: tenant.orgRole,
          isSuperadmin: tenant.isSuperadmin,
        }
      : null,
  };
}

export default function OrgLayout() {
  const matches = useMatches();
  const handle = baseHandleSchema.parse(matches[matches.length - 1]?.handle);

  return (
    <AppWrapper
      title={handle.title}
      backTo={handle.backTo}
    >
      <Outlet />
    </AppWrapper>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();
  const orgSlug = params.orgSlug;

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <AppWrapper title="Not Found">
        <div className="mx-auto max-w-2xl px-4 py-12">
          <h1 className="mb-4 text-3xl font-bold text-zinc-900 dark:text-zinc-100">
            Page Not Found
          </h1>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The page you're looking for doesn't exist.
          </p>
          <a
            href={orgSlug ? `/org/${orgSlug}/dashboard` : '/select-org'}
            className="inline-block text-blue-600 hover:underline dark:text-blue-400"
          >
            &larr; Back to dashboard
          </a>
        </div>
      </AppWrapper>
    );
  }

  reportError(error, { boundary: 'org-layout', orgSlug: orgSlug ?? null });

  return (
    <AppWrapper title="Error">
      <div className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="mb-4 text-3xl font-bold text-red-600 dark:text-red-400">
          Something Went Wrong
        </h1>
        <p className="mb-4 text-zinc-600 dark:text-zinc-400">
          An unexpected error occurred.
        </p>
        {error instanceof Error && (
          <pre className="overflow-auto rounded bg-zinc-100 p-4 text-sm dark:bg-zinc-800">
            {error.message}
          </pre>
        )}
        <a
          href={orgSlug ? `/org/${orgSlug}/dashboard` : '/select-org'}
          className="mt-4 inline-block text-blue-600 hover:underline dark:text-blue-400"
        >
          &larr; Back to dashboard
        </a>
      </div>
    </AppWrapper>
  );
}
