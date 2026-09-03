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
  // Accounts and the encrypted personal layer (M172)
  // =============================================================================
  // Resource routes: no default export, no UI. The browser derives its keys
  // locally and posts only the derived hash, so nothing here ever receives a
  // passphrase, a recovery code or a data key.
  route('/api/v1/auth/kdf', 'routes/api.v1.auth.kdf.ts'),
  route('/api/v1/auth/signup', 'routes/api.v1.auth.signup.ts'),
  route('/api/v1/auth/login', 'routes/api.v1.auth.login.ts'),
  route('/api/v1/auth/refresh', 'routes/api.v1.auth.refresh.ts'),
  route('/api/v1/auth/logout', 'routes/api.v1.auth.logout.ts'),
  route('/api/v1/auth/recover', 'routes/api.v1.auth.recover.ts'),
  route('/api/v1/auth/recover-rotate', 'routes/api.v1.auth.recover-rotate.ts'),
  route('/api/v1/auth/account', 'routes/api.v1.auth.account.ts'),
  // The signed-in devices of one account, and the revoke that ends one of
  // them. A device here is a TOKEN FAMILY, which is what `logout` already
  // revokes: there is no device registry to keep in step, and no new column.
  route('/api/v1/auth/devices', 'routes/api.v1.auth.devices.ts'),
  route('/api/v1/sync/blob', 'routes/api.v1.sync.blob.ts'),
  route('/api/v1/sync/key-records', 'routes/api.v1.sync.key-records.ts'),

  // Voice input's server half: a recorded clip in, a line of text out. Public
  // and free like the search it feeds, and guarded by the same per-IP and
  // per-session hourly limits and the same daily budget cap as enrichment. It
  // sits under `/api/v1/` for the flat naming, NOT for the bearer token: the
  // caller is a browser with no Web Speech API, not an API client.
  route('/api/v1/transcribe', 'routes/api.v1.transcribe.ts'),

  // Public and read only, unlike the bearer-token `/api/v1/*` routes above.
  route('/api/enrichment/:headwordId', 'routes/api.enrichment.$headwordId.ts'),

  // A public POST, gated by the SESSION rather than by a bearer token: the
  // caller is a fetcher inside an already-rendered entry page, not an API
  // client. The path deliberately sits BESIDE `/api/enrichment/`, not under it:
  // as `/api/enrichment/vote` it would be shadowed by the `:headwordId` dynamic
  // segment above and every vote would reach the poll loader instead.
  route('/api/enrichment-vote', 'routes/api.enrichment-vote.ts'),

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
    // Client only, like `/lists` itself: it reads the device's own store and
    // has no server loader, so it works with the network off. The service
    // worker does not precache it, so a HARD reload here while offline lands
    // on `/offline`; an in-app navigation from `/lists` does not.
    route('/lists/:listId', 'routes/lists.$listId.tsx'),
    // The flashcard loop over one list. Client only for the same reasons, and
    // for one more: a review session must not stall on a fetch between cards.
    route('/lists/:listId/review', 'routes/lists.$listId.review.tsx'),
    // The daily nudge's session. The three words it picks come from ANY list,
    // so there is no list id to hang them off: the entry ids travel in
    // `?entries=`, and the screen resolves them against the device's own store.
    route('/review', 'routes/review.tsx'),
    route('/history', 'routes/history.tsx'),
    route('/settings', 'routes/settings.tsx'),
    // Sync lives inside the app shell, not in `_public`, because it is a
    // setting of an app the visitor is already using and not a gateway into
    // it. There is no account in this product until somebody asks for a
    // second device, so `/settings` is the only entry point either of these
    // screens has.
    route('/sync/setup', 'routes/sync.setup.tsx'),
    route('/sync/login', 'routes/sync.login.tsx'),
    route('/account', 'routes/account.tsx'),
    // Inside `_app` so the offline fallback carries the same chrome as the
    // other shell routes the service worker precaches. It has no loader and no
    // action, so it renders with no network at all.
    route('/offline', 'routes/offline.tsx'),
  ]),

  layout('routes/_public.tsx', { id: '_public' }, [
    route('/logout', 'routes/logout.tsx'),

    // The three legal documents, all under `/legal/` rather than at the root.
    // One prefix keeps them together in a sitemap, in a footer and in a link
    // somebody pastes into a support thread, and it leaves the root namespace
    // to the product. `/terms` and `/privacy` used to sit at the root carrying
    // the ts-factory-stack boilerplate, which described accounts, payment
    // processors and profile data this product does not have; nothing links to
    // the old paths, so they are gone rather than redirected.
    route('/legal/imprint', 'routes/legal/imprint.tsx'),
    route('/legal/privacy', 'routes/legal/privacy.tsx'),
    route('/legal/terms', 'routes/legal/terms.tsx'),

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
      route('/super/whoami-ip', 'routes/super/whoami-ip.tsx'),
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
