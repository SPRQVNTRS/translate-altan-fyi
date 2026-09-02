# React Router 7 and Remix Development Guidelines

Remix was merged into React Router 7 (framework mode) in late 2024.

## Core Library Imports
- Do not import any packages from `@remix-run` - use `react-router` or `@react-router` instead
- When in doubt, refer to other route components in the `routes` folder

## Middleware Architecture (v8)

### Overview
The application uses React Router 7's middleware pattern for centralized authentication. The middleware runs before route loaders/actions and provides authenticated user context throughout the route tree.

### Enabling Middleware
Middleware requires the `v8_middleware` future flag in `react-router.config.ts`:
```typescript
export default {
  ssr: true,
  future: {
    v8_middleware: true,
  },
} satisfies Config;
```

### Middleware Implementation
Authentication middleware is defined in `app/middleware/auth.ts`:
```typescript
import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import { sessionStorage } from '#app/utils/auth.server';
import { userContext } from './context';

export const authMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const user = session.get('user') as User | null;

  if (!user) {
    throw redirect('/login');
  }

  if (user.deactivated) {
    throw redirect('/login', {
      headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
    });
  }

  context.set(userContext, user);
};
```

### Context and Helpers
User context is defined in `app/middleware/context.ts`:
```typescript
import type { User } from '#drizzle/types';
import { createContext } from 'react-router';

export const userContext = createContext<User | null>(null);
```

Helper function in `app/middleware/helpers.ts`:
```typescript
import { userContext } from './context';

export function getUser(context: { get: (ctx: typeof userContext) => User | null }): User {
  const user = context.get(userContext);
  if (!user) {
    throw new Error('User not found in context. This route may not be protected by authMiddleware.');
  }
  return user;
}
```

### Route Structure with Middleware
The `_auth.tsx` route exports the middleware:
```typescript
import { Outlet } from 'react-router';
import { authMiddleware } from '#app/middleware/auth';

export const middleware = [authMiddleware];

export default function AuthLayout() {
  return <Outlet />;
}
```

### Accessing User in Routes
Routes access the authenticated user through context:
```typescript
import type { Route } from './+types/some.route';
import { getUser } from '#app/middleware/helpers';

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  // User is guaranteed to be authenticated here
  return { user, /* other data */ };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = getUser(context);
  // Perform action with authenticated user
}

export default function SomeRoute() {
  const { user } = useLoaderData<typeof loader>();
  // Use authenticated user in component
}
```

### Route Registration
Protected routes must be nested under the `_auth` layout in `routes.ts`:
```typescript
import { layout, route } from '@react-router/dev/routes';

export default [
  // Public routes
  route('/login', 'routes/login.tsx'),

  // Protected routes (nested under _auth)
  layout('routes/_auth.tsx', [
    layout('routes/_layout.tsx', [
      route('/dashboard', 'routes/dashboard.tsx'),
      route('/profile', 'routes/profile.tsx'),
      // ... other protected routes
    ]),
  ]),
] satisfies RouteConfig;
```

### Naming Conventions
- Use underscore prefix for layout routes that don't correspond to URL segments
- Examples: `_auth.tsx`, `_layout.tsx`
- This follows React Router's pathless route convention

## Returning Data in Loaders and Actions
- **Loaders**: Simply return plain objects - the `json()` helper is deprecated
- **Actions**: Return plain objects for success responses
- **Error Responses**: Use `throw new Response()` for HTTP errors with status codes

```typescript
// ✅ Good - Return plain objects
export async function loader({ params }: Route.LoaderArgs) {
  const data = await getData(params.id);
  return { success: true, data };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    await updateData();
    return { success: true, message: 'Updated successfully' };
  } catch (error) {
    throw new Response('Update failed', { status: 500 });
  }
}

// ❌ Bad - Don't use json() wrapper (deprecated)
export async function loader() {
  return json({ data: 'value' }); // Don't do this
}
```

## Creating Route Components
- Create entry in `routes.ts`
- Create component in `routes/some-route.tsx`
- Export `loader` function for all routes and `action` for routes with forms
- Export `meta` and `handle` for metadata:

```typescript
export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const item = data as Awaited<ReturnType<typeof loader>>;
  return [{ title: `Item: ${item?.title ?? 'Not Found'}` }];
};

export const handle = {
  title: 'Page Title',
  backTo: '/dashboard',
};
```

## Nested Routes
- Parent routes must expose `<Outlet/>` component
- Hide parent components on child routes using location:

```typescript
import { Outlet, useLocation } from 'react-router';

export default function ParentRoute() {
  const location = useLocation();
  return (
    <div className="container mx-auto p-4">
      <Outlet />
      {location.pathname === '/parent' && (
        <span>I'm only rendered on the parent route</span>
      )}
    </div>
  );
}
```

## Route Type Imports
- Always import `Route` type from generated `+types` directory
- Do not fix linter errors on type imports - these are generated by dev server
- Never create these type files manually

```typescript
import type { Route } from './+types/some.route';

export async function loader({ request }: Route.LoaderArgs) {
  // ...
}

export async function action({ request }: Route.ActionArgs) {
  // ...
}
```

## Forms with Conform and Zod

### Schema Definition
```typescript
const NestedObjectSchema = z.object({
  fieldA: z.string().optional(),
  fieldB: z.coerce.number().optional(),
});

const FormSchema = z.object({
  mainField: z.string().min(1),
  nested: NestedObjectSchema, // Required object, optional fields
});
```

### Action Function
- Parse `request.formData()` using `parseWithZod`
- Check `submission.status` - if not `'success'`, return `submission.reply()`
- Use `redirectWithToast` on success or `submission.reply({ formErrors: [...] })` on failure

### Component Implementation
- Use `useFetcher<typeof action>()`
- Use Conform's `useForm<z.infer<typeof FormSchema>>({})`
- Provide `lastResult: fetcher.data as SubmissionResult<string[]> | undefined`
- Provide `onValidate({ formData }) { return parseWithZod(formData, { schema: FormSchema }); }`
- For nested fields: `const nestedFields = fields.nested.getFieldset()`

## Multiple Actions with Intents

### Define Intent Constants
```typescript
const INTENT = {
  UPDATE_DETAILS: 'update-details',
  UPLOAD_IMAGE: 'upload-image',
  DELETE_ITEM: 'delete-item',
} as const;
```

### Include Intent in Forms
```tsx
<fetcher.Form method="post">
  <input type="hidden" name="_intent" value={INTENT.UPDATE_DETAILS} />
  {/* other fields */}
  <Button type="submit">Update</Button>
</fetcher.Form>
```

### Route in Action Function
```typescript
export async function action({ request, params }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get('_intent');

  switch (intent) {
    case INTENT.UPDATE_DETAILS:
      return handleUpdateDetails(formData, id);
    case INTENT.DELETE_ITEM:
      return handleDeleteItem(formData);
    default:
      return { status: 'error', error: { '': ['Invalid action intent'] } } as SubmissionResult;
  }
}
```

## Debounced Search with Pagination

- Use `useState` for search input value
- Use `useEffect` with `setTimeout` for debouncing
- Use `useNavigate` (not `useSubmit`) inside debounced callback
- Reset page to 1 when searching
- Pass current `searchParams` to pagination component

```typescript
const debouncedNavigate = useCallback(
  (newQuery: string) => {
    const newSearchParams = new URLSearchParams();
    if (newQuery) {
      newSearchParams.set('q', newQuery);
    }
    newSearchParams.set('page', '1');
    navigate(`${location.pathname}?${newSearchParams.toString()}`, { replace: true });
  },
  [navigate, location.pathname]
);

useEffect(() => {
  if (searchQuery === (loaderQuery ?? '')) return;

  const timer = setTimeout(() => {
    debouncedNavigate(searchQuery);
  }, 300);

  return () => clearTimeout(timer);
}, [searchQuery, loaderQuery, debouncedNavigate]);
```

## Component Usage
- Always check `app/components/ui` for generic UI elements
- Check `app/components` for feature-specific components
- Ask before creating new reusable components in `app/components`
