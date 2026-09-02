import { type RouteConfig, route, layout, index } from '@react-router/dev/routes';

export default [
  // =============================================================================
  // Public Routes (No Auth Required)
  // =============================================================================
  route('/healthcheck', 'routes/healthcheck.ts'),

  // =============================================================================
  // REST API v1 (Bearer token auth, JSON only)
  // =============================================================================
  route('/api/v1/api-keys', 'routes/api.v1.api-keys.ts'),
  route('/api/v1/api-keys/:id', 'routes/api.v1.api-keys.$id.ts'),
  route('/api/v1/data-sources', 'routes/api.v1.data-sources.ts'),
  route('/api/v1/metric-events', 'routes/api.v1.metric-events.ts'),

  // Workflow endpoints, static routes MUST precede dynamic :id routes
  route('/api/v1/workflows', 'routes/api.v1.workflows.ts'),
  route('/api/v1/workflows/stats', 'routes/api.v1.workflows.stats.ts'),
  route('/api/v1/workflows/audit-tenancy', 'routes/api.v1.workflows.audit-tenancy.ts'),
  route('/api/v1/workflows/:id', 'routes/api.v1.workflows.$id.ts'),
  route('/api/v1/workflows/:id/operations', 'routes/api.v1.workflows.$id.operations.ts'),
  route('/api/v1/workflows/:id/context', 'routes/api.v1.workflows.$id.context.ts'),
  route('/api/v1/workflows/:id/cancel', 'routes/api.v1.workflows.$id.cancel.ts'),

  // User endpoints (superadmin only), static before dynamic
  route('/api/v1/users', 'routes/api.v1.users.ts'),
  route('/api/v1/users/by-email/:email', 'routes/api.v1.users.by-email.$email.ts'),
  route('/api/v1/users/:id', 'routes/api.v1.users.$id.ts'),

  // Org endpoints (superadmin only), static before dynamic
  route('/api/v1/orgs', 'routes/api.v1.orgs.ts'),
  route('/api/v1/orgs/:idOrSlug', 'routes/api.v1.orgs.$idOrSlug.ts'),
  route('/api/v1/orgs/:idOrSlug/members', 'routes/api.v1.orgs.$idOrSlug.members.ts'),

  // DB admin endpoints (superadmin only)
  route('/api/v1/admin/db/check', 'routes/api.v1.admin.db.check.ts'),
  route('/api/v1/admin/db/pool', 'routes/api.v1.admin.db.pool.ts'),
  route('/api/v1/admin/db/tables', 'routes/api.v1.admin.db.tables.ts'),
  route('/api/v1/admin/db/describe/:table', 'routes/api.v1.admin.db.describe.$table.ts'),
  route('/api/v1/admin/db/query', 'routes/api.v1.admin.db.query.ts'),

  // =============================================================================
  // App Shell (sidebar, mobile drawer, bottom tab bar)
  // =============================================================================
  layout('routes/_app.tsx', { id: '_app' }, [
    index('routes/search.tsx'),
    // `/search` renders the SAME module as the index route, under a second id.
    // The stage verification hits `/search`, and a redirect to `/` would be a
    // second round trip on every linkable results URL. Two ids over one file is
    // the shape `_auth.tsx` already uses twice further down, and React Router's
    // typegen emits ONE `+types/search` whose `Matches` is a union of both.
    route('/search', 'routes/search.tsx', { id: 'search-alias' }),
    route('/entry/:headwordId', 'routes/entry.$headwordId.tsx'),
    route('/attribution', 'routes/attribution.tsx'),
    route('/lists', 'routes/lists.tsx'),
    route('/history', 'routes/history.tsx'),
    route('/settings', 'routes/settings.tsx'),
    route('/account', 'routes/account.tsx'),
    // Inside `_app` so the offline fallback carries the same chrome as the
    // other shell routes the service worker precaches. It has no loader and no
    // action, so it renders with no network at all.
    route('/offline', 'routes/offline.tsx'),
  ]),

  layout('routes/_public.tsx', { id: '_public' }, [
    route('/login', 'routes/login.tsx'),
    route('/logout', 'routes/logout.tsx'),
    route('/register', 'routes/register.tsx'),
    route('/forgot-password', 'routes/forgot-password.tsx'),
    route('/terms', 'routes/legal/terms.tsx'),
    route('/privacy', 'routes/legal/privacy.tsx'),

    // Catch-all: unmatched URLs get 404 inside the layout
    route('*', 'routes/$.tsx'),
  ]),

  // =============================================================================
  // Authenticated Routes (Auth Required, No Org Context)
  // =============================================================================
  layout('routes/_auth.tsx', { id: '_auth' }, [
    // User dashboard (no org context)
    route('/dashboard', 'routes/dashboard.tsx'),

    // Organization selection & creation
    route('/select-org', 'routes/select-org.tsx'),
    route('/create-org', 'routes/create-org.tsx'),

    // Superadmin-only routes (global admin across all orgs)
    layout('routes/_super.tsx', { id: '_super' }, [
      route('/super/orgs', 'routes/super/orgs.tsx'),
      route('/super/users', 'routes/super/users.tsx'),
      route('/super/llm', 'routes/super/llm.tsx'),
    ]),
  ]),

  // =============================================================================
  // Organization-Scoped Routes (Auth + Org Context Required)
  // =============================================================================
  layout('routes/_auth.tsx', { id: '_auth_org' }, [
    layout('routes/org/_tenant.tsx', { id: '_tenant' }, [
      layout('routes/org/_layout.tsx', { id: '_org_layout' }, [
        // Dashboard & Profile
        route('/org/:orgSlug/dashboard', 'routes/org/dashboard.tsx'),
        route('/org/:orgSlug/profile', 'routes/org/profile.tsx'),
        route('/org/:orgSlug/settings', 'routes/org/settings.tsx'),

        // Workflows (org-scoped)
        route('/org/:orgSlug/workflows', 'routes/org/workflows.tsx'),

        // Admin routes (org-level admin, not superadmin)
        layout('routes/org/_admin.tsx', { id: '_org_admin' }, [
          // User management (admin only)
          route('/org/:orgSlug/users', 'routes/org/users/index.tsx'),
          route('/org/:orgSlug/users/invite', 'routes/org/users/invite.tsx'),
        ]),
      ]),
    ]),
  ]),
] satisfies RouteConfig;
