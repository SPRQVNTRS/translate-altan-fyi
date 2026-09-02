import type { Route } from './+types/invite';
import { Form, redirect, useNavigation } from 'react-router';
import { canInviteMembers } from '#app/middleware/tenant';
import { orgContext } from '#app/middleware/context';
import { addOrganizationMember } from '#app/models/organizations.server';
import { getUserByEmail } from '#app/models/users.server';
import { orgRoleSchema } from '#app/types/permissions';
import { RouteErrorBoundary } from '#app/components/route-error-boundary';
import { useFormField } from '#app/hooks/use-form-field';
import { useClearForm } from '#app/utils/form-storage';
import { useEffect, useRef } from 'react';
import { z } from 'zod';

export { RouteErrorBoundary as ErrorBoundary };

export const handle = {
  title: 'Invite User',
  backTo: '../',
};

// Require invite permission
export const middleware = [canInviteMembers];

/** Fields the invite form submits; an unset or unknown role defaults to `member`. */
const inviteFormSchema = z.object({
  email: z.string().min(1),
  role: orgRoleSchema.catch('member').default('member'),
});

export async function loader({ params }: Route.LoaderArgs) {
  return { orgSlug: params.orgSlug };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const org = context.get(orgContext);
  const formData = await request.formData();

  const fields = inviteFormSchema.safeParse(Object.fromEntries(formData));
  if (!fields.success) {
    return { error: 'Email is required.' };
  }
  const { email, role } = fields.data;

  // Find user by email
  const user = await getUserByEmail(email);
  if (!user) {
    return { error: 'No user found with this email address.' };
  }

  try {
    await addOrganizationMember({
      organizationId: org!.id,
      userId: user.id,
      role,
    });
  } catch {
    return { error: 'User is already a member of this organization.' };
  }

  return redirect(`/org/${params.orgSlug}/users`);
}

export default function InviteUser({ loaderData, actionData }: Route.ComponentProps) {
  const { orgSlug } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  const formId = `invite-user:${orgSlug}`;
  const [persistedEmail, setPersistedEmail] = useFormField(formId, 'email', '');
  const [persistedRole, setPersistedRole] = useFormField(formId, 'role', 'member');
  const clearForm = useClearForm(formId);

  // Clear persisted data on successful redirect
  const prevState = useRef(navigation.state);
  useEffect(() => {
    if (navigation.state === 'loading' && navigation.formAction) {
      clearForm();
    }
    prevState.current = navigation.state;
  }, [navigation.state, navigation.formAction, clearForm]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Invite User
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Add a new user to your organization by their email address.
      </p>

      {actionData?.error && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {actionData.error}
        </div>
      )}

      <Form method="post" className="mt-6 max-w-md space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Email Address
          </label>
          <input
            type="email"
            id="email"
            name="email"
            required
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-700"
            placeholder="user@example.com"
            value={persistedEmail}
            onChange={(e) => setPersistedEmail(e.target.value)}
          />
        </div>

        <div>
          <label
            htmlFor="role"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Role
          </label>
          <select
            id="role"
            name="role"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-700"
            value={persistedRole}
            onChange={(e) => setPersistedRole(e.target.value)}
          >
            <option value="viewer">Viewer</option>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Inviting...' : 'Invite User'}
          </button>
          <a
            href={`/org/${orgSlug}/users`}
            className="rounded-lg border border-zinc-300 px-4 py-2 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </a>
        </div>
      </Form>
    </div>
  );
}
