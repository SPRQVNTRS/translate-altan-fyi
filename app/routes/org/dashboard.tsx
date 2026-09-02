import type { Route } from './+types/dashboard';
import { tenantContext, orgContext } from '#app/middleware/context';
import { getUser } from '#app/middleware/helpers';
import { RouteErrorBoundary } from '#app/components/route-error-boundary';

export { RouteErrorBoundary as ErrorBoundary };

export const handle = {
  title: 'Dashboard',
};

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  const tenant = context.get(tenantContext);
  const org = context.get(orgContext);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      isSuperadmin: user.isSuperadmin,
    },
    tenant: tenant
      ? {
          orgRole: tenant.orgRole,
          permissions: tenant.permissions,
        }
      : null,
    org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
  };
}

export default function OrgDashboard({ loaderData }: Route.ComponentProps) {
  const { user, tenant, org } = loaderData;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Dashboard
        </h1>
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          Welcome to {org?.name}
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* User Info Card */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Your Account
          </h2>
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">Name:</span>{' '}
              <span className="text-zinc-900 dark:text-zinc-100">{user.name}</span>
            </p>
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">Email:</span>{' '}
              <span className="text-zinc-900 dark:text-zinc-100">{user.email}</span>
            </p>
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">Role in Org:</span>{' '}
              <span className="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                {tenant?.orgRole}
              </span>
            </p>
            {user.isSuperadmin && (
              <p>
                <span className="inline-flex rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                  Superadmin
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Organization Info Card */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Organization
          </h2>
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">Name:</span>{' '}
              <span className="text-zinc-900 dark:text-zinc-100">{org?.name}</span>
            </p>
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">Slug:</span>{' '}
              <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-700">
                {org?.slug}
              </code>
            </p>
          </div>
        </div>

        {/* Quick Actions Card */}
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Quick Actions
          </h2>
          <div className="space-y-2">
            <a
              href={`/org/${org?.slug}/users`}
              className="block rounded-md bg-zinc-100 px-4 py-2 text-sm text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
            >
              Users
            </a>
            <a
              href={`/org/${org?.slug}/settings`}
              className="block rounded-md bg-zinc-100 px-4 py-2 text-sm text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
            >
              Settings
            </a>
          </div>
        </div>
      </div>

      {/* Permissions Debug (Development) */}
      {process.env.NODE_ENV === 'development' && tenant?.permissions && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
          <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Your Permissions (dev only)
          </h3>
          <div className="flex flex-wrap gap-1">
            {tenant.permissions.map((perm) => (
              <span
                key={perm}
                className="rounded bg-zinc-200 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300"
              >
                {perm}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
