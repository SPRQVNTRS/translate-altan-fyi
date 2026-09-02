---
name: react-router-framework-mode
description: Build full-stack features with React Router framework mode (this stack's SSR setup). Use when configuring routes (app/routes.ts), writing loaders/actions/clientLoaders, handling forms, navigation, pending/optimistic UI, error boundaries, meta exports, or editing react-router.config.ts. Vendored from the official remix-run React Router agent skill; adapted for React Router v8.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# React Router Framework Mode

Framework mode is React Router's full-stack development experience with file-based routing, server-side/client-side/static rendering strategies, data loading and mutations, and a type-safe route module API. This is the mode translate-altan-fyi runs (SSR via Express in `server.ts`).

> Origin: this skill is vendored from the official [`remix-run` React Router agent skill](https://github.com/remix-run/react-router) (framework-mode). The reference docs under `references/` are the upstream files. Where upstream still notes "v7.9.0+ / `v8_middleware` flag", this stack is on **React Router v8**, where middleware and the other former `v8_*` future flags are always-on defaults — do not add `future` flags for them.

## When to Apply

- Configuring new routes (`app/routes.ts`)
- Loading data with `loader` or `clientLoader`
- Handling mutations with `action` or `clientAction`
- Navigating with `<Link>`, `<NavLink>`, `<Form>`, `redirect`, and `useNavigate`
- Implementing pending/loading UI states
- Configuring SSR, SPA mode, or pre-rendering (`react-router.config.ts`)
- Implementing authentication

## References

Load the relevant reference for detailed guidance on the specific API/concept:

| Reference                            | Use When                                              |
| ------------------------------------ | ----------------------------------------------------- |
| `references/routing.md`              | Configuring routes, nested routes, dynamic segments   |
| `references/route-modules.md`        | Understanding all route module exports                |
| `references/special-files.md`        | Customizing root.tsx, adding global nav/footer, fonts |
| `references/data-loading.md`         | Loading data with loaders, streaming, caching         |
| `references/actions.md`              | Handling forms, mutations, validation                 |
| `references/navigation.md`           | Links, programmatic navigation, redirects             |
| `references/pending-ui.md`           | Loading states, optimistic UI                         |
| `references/error-handling.md`       | Error boundaries, error reporting                     |
| `references/rendering-strategies.md` | SSR vs SPA vs pre-rendering configuration             |
| `references/middleware.md`           | Adding middleware (always-on in v8)                   |
| `references/sessions.md`             | Cookie sessions, authentication, protected routes     |
| `references/type-safety.md`          | Auto-generated route types, type imports, type safety |

## Version Compatibility (this stack)

translate-altan-fyi targets **React Router v8**. Verify the installed version before implementing:

```bash
pnpm list react-router
```

| Feature                 | Availability in v8 | Notes                                              |
| ----------------------- | ------------------ | -------------------------------------------------- |
| Middleware              | Always enabled     | No `future.v8_middleware` flag — it graduated in v8 |
| Core framework features | Always enabled     | loaders, actions, `Form`, `meta`, etc.             |
| Split route modules     | Default            | `splitRouteModules` config, on by default          |
| Vite Environment API    | Always enabled     | Requires Vite 7+; this stack runs Vite 8           |

Import from `react-router` (and `react-router/dom` for DOM-only render entry points). The old `react-router-dom` package does **not** exist in v8 — never add it.

## Critical Patterns

These are the most important patterns to follow. Load the relevant reference for full details.

### Forms & Mutations

**Search forms** - use `<Form method="get">`, NOT `onSubmit` with `setSearchParams`:

```tsx
// ✅ Correct
<Form method="get">
  <input name="q" />
</Form>

// ❌ Wrong - don't manually handle search params
<form onSubmit={(e) => { e.preventDefault(); setSearchParams(...) }}>
```

**Inline mutations** - use `useFetcher`, NOT `<Form>` (which causes page navigation):

```tsx
const fetcher = useFetcher();
const optimistic = fetcher.formData?.get("favorite") === "true" ?? isFavorite;

<fetcher.Form method="post" action={`/favorites/${id}`}>
  <button>{optimistic ? "★" : "☆"}</button>
</fetcher.Form>;
```

See `references/actions.md` for complete patterns.

### Layouts

**Global UI belongs in `root.tsx`** - don't create separate layout files for nav/footer:

```tsx
// app/root.tsx - add navigation, footer, providers here
export default function App() {
  return (
    <div>
      <nav>...</nav>
      <Outlet />
      <footer>...</footer>
    </div>
  );
}
```

**Use nested routes** for section-specific layouts. See `references/routing.md`.

### Route Module Exports

**`meta` uses `loaderData`**, not the removed `data` arg (removed in v8):

```tsx
// ✅ Correct
export function meta({ loaderData }: Route.MetaArgs) { ... }

// ❌ Wrong - `data` was deprecated in v7 and removed in v8
export function meta({ data }: Route.MetaArgs) { ... }
```

See `references/route-modules.md` for all exports.

## Further Documentation

If anything related to React Router is not covered in these references, search the official documentation:

https://reactrouter.com/docs
