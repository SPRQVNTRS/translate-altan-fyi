import type { Route } from './+types/profile';
import { getUser } from '#app/middleware/helpers';
import { RouteErrorBoundary } from '#app/components/route-error-boundary';

export { RouteErrorBoundary as ErrorBoundary };

export const handle = {
  title: 'Profile',
};

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  return { user };
}

export default function OrgProfile({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;

  return (
    <div>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Profile</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Manage your profile settings.
      </p>
      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-700 dark:bg-zinc-800">
        <p>
          <strong>Name:</strong> {user.name}
        </p>
        <p>
          <strong>Email:</strong> {user.email}
        </p>
      </div>
    </div>
  );
}
