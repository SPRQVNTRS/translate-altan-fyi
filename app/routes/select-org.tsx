import type { Route } from './+types/select-org';
import { Link, redirect } from 'react-router';
import { getUser } from '#app/middleware/helpers';
import { getUserOrganizations } from '#app/models/organizations.server';

export const handle = {
  title: 'Select Organization',
};

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);

  // Fetch user's organizations
  const memberships = await getUserOrganizations(user.id);

  // If user has exactly one org, redirect directly to it
  if (memberships.length === 1) {
    throw redirect(`/org/${memberships[0].organization.slug}/dashboard`);
  }

  // If user has no orgs and is not superadmin, redirect to create org
  if (memberships.length === 0 && !user.isSuperadmin) {
    throw redirect('/create-org');
  }

  return {
    user,
    organizations: memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    })),
  };
}

export default function SelectOrg({ loaderData }: Route.ComponentProps) {
  const { user, organizations } = loaderData;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="rounded-lg bg-white p-8 shadow-md">
          <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
            Select Organization
          </h1>

          <p className="mb-6 text-center text-gray-600">
            Welcome back, {user.name}! Select an organization to continue.
          </p>

          {organizations.length > 0 ? (
            <div className="space-y-3">
              {organizations.map((org) => (
                <Link
                  key={org.id}
                  to={`/org/${org.slug}/dashboard`}
                  className="flex items-center justify-between rounded-lg border border-gray-200 p-4 transition-colors hover:border-blue-500 hover:bg-blue-50"
                >
                  <div>
                    <div className="font-medium text-gray-900">{org.name}</div>
                    <div className="text-sm text-gray-500">{org.role}</div>
                  </div>
                  <svg
                    className="h-5 w-5 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-center text-gray-500">
              You are not a member of any organizations.
            </p>
          )}

          <div className="mt-6 border-t border-gray-200 pt-6">
            <Link
              to="/create-org"
              className="block w-full rounded-lg bg-blue-600 px-4 py-2 text-center font-medium text-white transition-colors hover:bg-blue-700"
            >
              Create New Organization
            </Link>
          </div>

          {user.isSuperadmin && (
            <div className="mt-4">
              <Link
                to="/super/orgs"
                className="block w-full rounded-lg border border-gray-300 px-4 py-2 text-center font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                Superadmin: Manage All Organizations
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
