import type { Route } from './+types/dashboard';
import { Link } from 'react-router';
import { getUser } from '#app/middleware/helpers';
import { getUserOrganizations } from '#app/models/organizations.server';
import { Building2, Plus, Shield, ChevronRight } from 'lucide-react';

export const handle = {
  title: 'Dashboard',
};

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  const memberships = await getUserOrganizations(user.id);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      isSuperadmin: user.isSuperadmin,
    },
    organizations: memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    })),
  };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, organizations } = loaderData;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-900">
      <div className="mx-auto max-w-4xl px-4 py-12">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
            Welcome back, {user.name}
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Select an organization to get started, or create a new one.
          </p>
        </div>

        {/* Organizations Grid */}
        <div className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            <Building2 className="h-5 w-5" />
            Your Organizations
          </h2>

          {organizations.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {organizations.map((org) => (
                <Link
                  key={org.id}
                  to={`/org/${org.slug}/dashboard`}
                  className="group flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-5 transition-all hover:border-blue-500 hover:shadow-md dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-blue-500"
                >
                  <div>
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {org.name}
                    </div>
                    <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          org.role === 'owner'
                            ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                            : org.role === 'admin'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                              : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200'
                        }`}
                      >
                        {org.role}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5 text-zinc-400 transition-transform group-hover:translate-x-1 group-hover:text-blue-500" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-700 dark:bg-zinc-800">
              <Building2 className="mx-auto h-12 w-12 text-zinc-400" />
              <p className="mt-4 text-zinc-600 dark:text-zinc-400">
                You're not a member of any organizations yet.
              </p>
              <Link
                to="/create-org"
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Create Your First Organization
              </Link>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-4">
          <Link
            to="/create-org"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          >
            <Plus className="h-4 w-4" />
            Create Organization
          </Link>

          {user.isSuperadmin && (
            <Link
              to="/super/orgs"
              className="inline-flex items-center gap-2 rounded-lg border border-purple-300 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700 hover:bg-purple-100 dark:border-purple-700 dark:bg-purple-900/20 dark:text-purple-300 dark:hover:bg-purple-900/40"
            >
              <Shield className="h-4 w-4" />
              Platform Admin
            </Link>
          )}
        </div>

        {/* Account Info */}
        <div className="mt-12 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-800">
          <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Account
          </h2>
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">Email:</span>{' '}
              <span className="text-zinc-900 dark:text-zinc-100">{user.email}</span>
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
      </div>
    </div>
  );
}
