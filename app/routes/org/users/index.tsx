import type { Route } from './+types/index';
import { Link } from 'react-router';
import { tenantContext, orgContext } from '#app/middleware/context';
import { getOrganizationMembers } from '#app/models/organizations.server';
import { RouteErrorBoundary } from '#app/components/route-error-boundary';

export { RouteErrorBoundary as ErrorBoundary };

export const handle = {
  title: 'Users',
};

export async function loader({ context, params }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  const org = context.get(orgContext);

  const members = await getOrganizationMembers(org!.id);

  return {
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    orgSlug: params.orgSlug,
    canInvite: tenant?.permissions.includes('members:invite') ?? false,
    canManage: tenant?.permissions.includes('members:manage') ?? false,
  };
}

export default function OrgUsers({ loaderData }: Route.ComponentProps) {
  const { members, orgSlug, canInvite, canManage } = loaderData;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Users</h1>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Manage your organization's users.
          </p>
        </div>
        {canInvite && (
          <Link
            to={`/org/${orgSlug}/users/invite`}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Invite User
          </Link>
        )}
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
        <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
          <thead className="bg-zinc-50 dark:bg-zinc-800">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Member
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Role
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Joined
              </th>
              {canManage && (
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-700 dark:bg-zinc-800">
            {members.map((member) => (
              <tr key={member.id}>
                <td className="whitespace-nowrap px-6 py-4">
                  <div>
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {member.name}
                    </div>
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">
                      {member.email}
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-6 py-4">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      member.role === 'owner'
                        ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                        : member.role === 'admin'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                          : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200'
                    }`}
                  >
                    {member.role}
                  </span>
                </td>
                <td className="whitespace-nowrap px-6 py-4 text-sm text-zinc-600 dark:text-zinc-400">
                  {member.joinedAt
                    ? new Date(member.joinedAt).toLocaleDateString()
                    : '-'}
                </td>
                {canManage && (
                  <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                    {member.role !== 'owner' && (
                      <button className="text-red-600 hover:underline dark:text-red-400">
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
