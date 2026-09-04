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
  // The `workflows`, `users`, `orgs`, `data-sources` and `metric-events`
  // endpoints stood here until M189 (ADR-0010). The workflow TABLES live on,
  // because enrichment writes them and the CLI reads them; the REST surface
  // over them had no caller at all.

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

  // Voice input's server half: a recorded clip in, a line of text out. It sits
  // under `/api/v1/` for the flat naming, NOT for the bearer token: the caller
  // is a browser with no Web Speech API, not an API client.
  //
  // GATED INLINE since M184, by its own account check rather than by a layout:
  // it is a resource route with no chrome and it must answer a refusal in JSON,
  // because a `fetch` cannot make sense of a redirect to a sign-in page. The
  // per-IP and per-session hourly limits and the daily budget cap all stay
  // behind that check, as defence in depth.
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
    // ── The public half of the shell ────────────────────────────────────
    // Everything directly under `_app` renders for a signed-out visitor. The
    // gated half is the `_app.gated.tsx` block below, and the nesting is what
    // classifies a route: `app/lib/route-classification.ts` records the same
    // fact in one readable place, and a unit test fails when a route file
    // exists in neither.
    index('routes/search.tsx'),
    // `/search` renders the SAME module as the index route, under a second id.
    // The stage verification hits `/search`, and a redirect to `/` would be a
    // second round trip on every linkable results URL. React Router's typegen
    // emits ONE `+types/search` whose `Matches` is a union of both ids.
    //
    // BOTH IDS ARE PUBLIC HERE, AND NEITHER IS OPEN. The account rule for this
    // screen is keyed on the REQUEST, not on the path: an empty `q` is the
    // landing page and a non-empty `q` needs a session, decided at the top of
    // the one loader both ids share. Gating the alias from here instead would
    // gate `/search?q=` and leave `/?q=`, the primary URL, wide open, which is
    // the exact hole M184 exists to close.
    route('/search', 'routes/search.tsx', { id: 'search-alias' }),
    // The two doors, inside the app shell rather than in `_public`, because a
    // visitor arriving at one is already looking at the product. Both stay
    // PUBLIC: they are the front door an invited person walks through, and a
    // gate in front of the sign-in page is a gate nobody can ever pass.
    //
    // THE PATHS NAME THE ACCOUNT, NOT THE SYNC. They were `/sync/setup` and
    // `/sync/login` until M189, which asked a newcomer to configure a feature
    // before they had an account for it to apply to. Sync is a consequence of
    // holding an account, never a thing a reader sets up.
    route('/sign-up', 'routes/sign-up.tsx'),
    route('/sign-in', 'routes/sign-in.tsx'),
    // The old paths, kept forever. They are in bookmarks, in histories and in
    // invites already sent, and each hop preserves the query string so an
    // `?invite=` survives it. Loader only: a hop is not a screen.
    route('/sync/setup', 'routes/sync.setup-redirect.ts'),
    route('/sync/login', 'routes/sync.login-redirect.ts'),
    // Public, and it reports the signed-out state rather than ending it. Its
    // loader already answers `null` for an anonymous visitor and never
    // redirects, which is the contract a public account screen needs.
    route('/account', 'routes/account.tsx'),
    // Inside `_app` so the offline fallback carries the same chrome as the
    // other shell routes the service worker precaches. It has no loader and no
    // action, so it renders with no network at all, which is also why it can
    // never be gated: a session cannot be resolved with the network off.
    route('/offline', 'routes/offline.tsx'),

    // ── The gated half (M184, ADR-0009) ─────────────────────────────────
    // A pathless layout carrying `accountMiddleware`. Every route in here has
    // NO public surface to preserve, so a layout-level redirect is the right
    // shape for it. See `routes/_app.gated.tsx` for why the middleware cannot
    // sit on `_app.tsx` itself.
    layout('routes/_app.gated.tsx', { id: '_app_gated' }, [
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
    ]),
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
  // Superadmin Routes (operator screens, no organization anywhere)
  // =============================================================================
  // A TOP-LEVEL LAYOUT SINCE M189. It used to nest under `_auth.tsx`, which
  // demanded a linked `users` row on top of the account session; that file and
  // the whole org surface below it are gone, so `_super.tsx` now carries the
  // account resolution and the superadmin check itself.
  layout('routes/_super.tsx', { id: '_super' }, [
    // `/super` is a hop, not a screen. Two screens are left here and one of
    // them is the reason an operator ever visits, so a bare `/super` lands on
    // it rather than on a 404.
    route('/super', 'routes/super/index-redirect.ts'),
    // The model configuration enrichment reads out of `app_settings`.
    route('/super/llm', 'routes/super/llm.tsx'),
    // What the server believes the caller's IP is, for checking the
    // `TRUST_PROXY` hop count against a live reverse proxy.
    route('/super/whoami-ip', 'routes/super/whoami-ip.tsx'),
  ]),
] satisfies RouteConfig;
