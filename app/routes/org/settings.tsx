import type { Route } from './+types/settings';
import { orgContext, tenantContext } from '#app/middleware/context';
import { RouteErrorBoundary } from '#app/components/route-error-boundary';

export { RouteErrorBoundary as ErrorBoundary };

export const handle = {
  title: 'Settings',
};

export async function loader({ context }: Route.LoaderArgs) {
  const org = context.get(orgContext);
  const tenant = context.get(tenantContext);

  return {
    org: org ? { id: org.id, name: org.name, slug: org.slug, settings: org.settings } : null,
    canEdit: tenant?.permissions.includes('settings:write') ?? false,
  };
}

export default function OrgSettings({ loaderData }: Route.ComponentProps) {
  const { org, canEdit } = loaderData;

  return (
    <div>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Organization Settings
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Manage your organization settings.
      </p>

      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-800">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          General
        </h2>
        <div className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="org-name"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Organization Name
            </label>
            <input
              id="org-name"
              type="text"
              defaultValue={org?.name}
              disabled={!canEdit}
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 shadow-sm disabled:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-700 dark:disabled:bg-zinc-800"
            />
          </div>
          <div>
            <label
              htmlFor="org-slug"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              URL Slug
            </label>
            <input
              id="org-slug"
              type="text"
              defaultValue={org?.slug}
              disabled
              className="mt-1 block w-full rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 shadow-sm dark:border-zinc-600 dark:bg-zinc-800"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Slug cannot be changed after creation.
            </p>
          </div>
        </div>

        {!canEdit && (
          <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">
            You don't have permission to edit settings.
          </p>
        )}
      </div>
    </div>
  );
}
