import type { Route } from './+types/orgs';
import { Link } from 'react-router';
import { getOrganizations } from '#app/models/organizations.server';

export const handle = {
  title: 'All Organizations',
};

export async function loader() {
  // Superadmin can see all organizations
  const organizations = await getOrganizations();

  return { organizations };
}

export default function AdminOrgs({ loaderData }: Route.ComponentProps) {
  const { organizations } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            All Organizations
          </h1>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Superadmin view of all organizations in the system.
          </p>
        </div>
        <Link
          to="/select-org"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Back to Org Selection
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
        <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
          <thead className="bg-zinc-50 dark:bg-zinc-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Organization
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Slug
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Created
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-700 dark:bg-zinc-800">
            {organizations.map((org) => (
              <tr key={org.id}>
                <td className="whitespace-nowrap px-6 py-4 font-medium text-zinc-900 dark:text-zinc-100">
                  {org.name}
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <code className="rounded bg-zinc-100 px-2 py-0.5 text-sm dark:bg-zinc-700">
                    {org.slug}
                  </code>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-zinc-600 dark:text-zinc-400">
                  {org.createdAt ? new Date(org.createdAt).toLocaleDateString() : '-'}
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                  <Link
                    to={`/org/${org.slug}/dashboard`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Enter
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
