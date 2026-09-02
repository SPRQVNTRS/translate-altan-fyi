import type { Route } from './+types/create-org';
import { useEffect, useRef } from 'react';
import { Form, redirect, useNavigation } from 'react-router';
import { getUser } from '#app/middleware/helpers';
import { useFormField } from '#app/hooks/use-form-field';
import {
  createOrganizationWithOwner,
  generateSlug,
  isSlugAvailable,
} from '#app/models/organizations.server';
import { useClearForm } from '#app/utils/form-storage';
import { z } from 'zod';

export const handle = {
  title: 'Create Organization',
};

/** Fields the create-organization form submits. */
const createOrgFormSchema = z.object({
  name: z.string().min(2),
  slug: z.string().optional().default(''),
});

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  return { user };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = getUser(context);
  const formData = await request.formData();

  const fields = createOrgFormSchema.safeParse(Object.fromEntries(formData));
  if (!fields.success) {
    return { error: 'Organization name must be at least 2 characters.' };
  }
  const { name } = fields.data;

  // Generate slug if not provided
  const slug = fields.data.slug || generateSlug(name);

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { error: 'Slug can only contain lowercase letters, numbers, and hyphens.' };
  }

  // Check slug availability
  const available = await isSlugAvailable(slug);
  if (!available) {
    return { error: 'This URL slug is already taken. Please choose another.' };
  }

  // Create organization with user as owner
  const org = await createOrganizationWithOwner({ name, slug }, user.id);

  // NOTHING IS WRITTEN TO THE SESSION. Memberships used to be cached in the
  // cookie by the bcrypt login and refreshed here. `authMiddleware` now reads
  // them from the database on every request, so a cache would only be a second
  // copy that can go stale, and a stale copy of somebody's permissions is the
  // one thing a cookie should never hold. The new membership is live the moment
  // this transaction commits.
  return redirect(`/org/${org.slug}/dashboard`);
}

export default function CreateOrg({ loaderData, actionData }: Route.ComponentProps) {
  const { user } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  const [persistedName, setPersistedName] = useFormField('create-org', 'name', '');
  const [persistedSlug, setPersistedSlug] = useFormField('create-org', 'slug', '');
  const clearForm = useClearForm('create-org');

  // Clear persisted data on successful redirect
  const prevState = useRef(navigation.state);
  useEffect(() => {
    if (prevState.current === 'loading' && navigation.state === 'idle') {
      // Navigation completed. If we were redirected, the form was successful.
    }
    if (navigation.state === 'loading' && navigation.formAction) {
      clearForm();
    }
    prevState.current = navigation.state;
  }, [navigation.state, navigation.formAction, clearForm]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="rounded-lg bg-white p-8 shadow-md">
          <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
            Create Organization
          </h1>

          <p className="mb-6 text-center text-gray-600">
            Create a new organization to get started.
          </p>

          {actionData?.error && (
            <div className="mb-4 rounded-md bg-red-50 p-4 text-sm text-red-700">
              {actionData.error}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-gray-700"
              >
                Organization Name
              </label>
              <input
                type="text"
                id="name"
                name="name"
                required
                minLength={2}
                value={persistedName}
                onChange={(e) => setPersistedName(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="My Company"
              />
            </div>

            <div>
              <label
                htmlFor="slug"
                className="block text-sm font-medium text-gray-700"
              >
                URL Slug (optional)
              </label>
              <div className="mt-1 flex rounded-md shadow-sm">
                <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-300 bg-gray-50 px-3 text-sm text-gray-500">
                  /org/
                </span>
                <input
                  type="text"
                  id="slug"
                  name="slug"
                  pattern="[a-z0-9-]+"
                  value={persistedSlug}
                  onChange={(e) => setPersistedSlug(e.target.value)}
                  className="block w-full rounded-r-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="my-company"
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Leave blank to auto-generate from name
              </p>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Creating...' : 'Create Organization'}
            </button>
          </Form>

          {user.memberships?.length > 0 && (
            <div className="mt-6 border-t border-gray-200 pt-6 text-center">
              <a
                href="/select-org"
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Back to organization selection
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
