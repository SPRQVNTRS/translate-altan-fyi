/**
 * Every file under `app/routes/`, and how it decides whether a caller may see
 * it (M184, ADR-0009).
 *
 * WHY A MANIFEST AT ALL, WHEN THE ROUTING TREE ALREADY SAYS MOST OF THIS.
 *   Because it does not say all of it, and the parts it leaves out are the ones
 *   that cost money. Three of this app's gates are invisible in `routes.ts`:
 *   `search.tsx` decides per REQUEST inside its loader, `api.v1.transcribe.ts`
 *   and `api.enrichment-vote.ts` each carry their own check in the file, and
 *   the `/api/v1/*` routes answer to a bearer token rather than to a session.
 *   A reader auditing "what can an anonymous stranger reach" would otherwise
 *   have to open seventy files to find out, and the first draft of this
 *   milestone proved what happens when somebody reads the tree and stops: it
 *   gated `/search` and left `/?q=` open, which is the same loader.
 *
 *   The second job is the one the test does: a new route file that nobody
 *   classified fails `tests/unit/route-classification-completeness.test.ts`.
 *   The failure is the point. It does not check that the classification is
 *   RIGHT, which no static check could, it checks that somebody was made to
 *   think about it before the file could ship.
 *
 * WHAT THIS MODULE IS NOT. It is not a gate and nothing enforces anything from
 * it at runtime. A rule that read this map to decide access would be keyed on
 * the path, and a path-keyed rule is exactly the defect M184 exists to remove:
 * `/` and `/search` are two paths over one file, so no map keyed on either of
 * them could ever describe that file's real rule. The gates live where the
 * decision is made, this map records where to find them.
 *
 * KEYS ARE PATHS RELATIVE TO `app/routes/`, with forward slashes, exactly as
 * the completeness test lists them from the file system.
 */

/**
 * How a file under `app/routes/` decides who may reach it.
 *
 * The categories are about the MECHANISM, not about the answer, because the
 * mechanism is the thing a reader has to go and find. Two routes can both be
 * "signed in only" and be enforced in places that look nothing alike.
 */
export type RouteAccess =
  /** Reachable by anyone, signed in or not, with no account check anywhere in the file. */
  | 'public'
  /**
   * `search.tsx`, and only `search.tsx`. One file, two route ids, and a rule
   * keyed on the REQUEST inside the one loader they share: an empty `q` is the
   * public landing page, any non-empty `q` requires an account. Its own
   * category because neither `public` nor `gated-layout` is true of it, and
   * calling it either one is how the hole reopens.
   */
  | 'landing-loader-split'
  /** Gated by `middleware` on a layout it is nested under in `app/routes.ts`. */
  | 'gated-layout'
  /** Gated by a check written in the file itself: its own `middleware` export, or a session read in its loader or action. */
  | 'gated-inline'
  /** A `/api/v1/*` resource route authenticated by an API key, through `requireApiKey` or `requireSuperadminApiKey`. */
  | 'bearer-token'
  /** A helper module that happens to live under `app/routes/`. It is imported, never routed. */
  | 'module'
  /**
   * A route-shaped file that `app/routes.ts` does not register. Unreachable.
   * NO FILE IS THIS TODAY: the one that was, `_admin.tsx`, was deleted with the
   * rest of the org surface by M189 (ADR-0010). The category stays because the
   * next inherited leftover has to be classified as something, and calling one
   * `gated-layout` because it looks like one is how a dead file gets read as a
   * live gate.
   */
  | 'unrouted'
  /**
   * Registered by `app/routes.ts` only when `NODE_ENV` is not `production`, so
   * a production build has no such route, and the file's own loader answers 404
   * if one is reached anyway. Its own category because none of the others is
   * true of it: it is neither public, since production cannot serve it, nor
   * gated, since no session is involved in refusing it.
   */
  | 'dev-only';

export interface RouteClassification {
  access: RouteAccess;
  /** Why, in one line. A category on its own does not tell the next reader where to look. */
  reason: string;
}

/**
 * The manifest. Every file under `app/routes/` appears exactly once.
 *
 * `satisfies` rather than an annotation, so the key set stays a literal type
 * and a lookup for a path that is not here is a compile error rather than
 * `undefined`.
 */
export const ROUTE_CLASSIFICATION = {
  // ── The app shell ──────────────────────────────────────────────────────
  '_app.tsx': {
    access: 'public',
    reason: 'The shell itself. It carries no middleware on purpose, because `/` inside it must render for a stranger.',
  },
  '_app.gated.tsx': {
    access: 'gated-layout',
    reason: 'The pathless layout that carries `accountMiddleware`. Everything nested under it inherits the gate.',
  },
  'search.tsx': {
    access: 'landing-loader-split',
    reason: 'Served at `/` and at `/search`. Empty `q` is public, any non-empty `q` requires an account, decided in the one shared loader.',
  },
  'account.tsx': {
    access: 'public',
    reason: 'Reports the signed-out state rather than ending it. Its loader answers `null` for an anonymous visitor and never redirects.',
  },
  'sign-up.tsx': {
    access: 'public',
    reason:
      'Account creation. A gate here would be a gate nobody could ever pass. Its loader reads `?invite=` from the URL, and sends a reader who ALREADY has a resolvable session on to `/account`: it refuses nobody, it answers a finished question.',
  },
  'sign-in.tsx': {
    access: 'public',
    reason:
      'Where every gated redirect lands, and where the link to account creation lives. Its loader sends an already signed-in reader to `/account` and turns no signed-out caller away.',
  },
  'sync.setup-redirect.ts': {
    access: 'public',
    reason: 'A permanent redirect from the old `/sync/setup` to `/sign-up`. It reads no session and answers every caller the same way.',
  },
  'sync.login-redirect.ts': {
    access: 'public',
    reason: 'A permanent redirect from the old `/sync/login` to `/sign-in`. It reads no session and answers every caller the same way.',
  },
  'offline.tsx': {
    access: 'public',
    reason: 'The service-worker fallback. It renders with no network, which is not a state in which a session can be resolved.',
  },
  'entry.$headwordId.tsx': {
    access: 'gated-layout',
    reason: 'Under `_app.gated`. It enqueues enrichment, so leaving it public would move the hole here from `/?q=`.',
  },
  'attribution.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`.' },
  'lists.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`. The device keeps its own copy either way, the gate blocks the screen only.' },
  'lists.$listId.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`.' },
  'lists.$listId.review.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`.' },
  'review.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`.' },
  'history.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`.' },
  'settings.tsx': { access: 'gated-layout', reason: 'Under `_app.gated`.' },

  // ── The public layout ──────────────────────────────────────────────────
  '_public.tsx': { access: 'public', reason: 'The chrome around the legal pages and the catch-all.' },
  'logout.tsx': { access: 'public', reason: 'Signing out must work from any state, including a broken one.' },
  'legal/imprint.tsx': { access: 'public', reason: 'A legal document. It is a legal requirement that it is reachable.' },
  'legal/privacy.tsx': { access: 'public', reason: 'A legal document.' },
  'legal/terms.tsx': { access: 'public', reason: 'A legal document.' },
  '$.tsx': { access: 'public', reason: 'The 404. Every unmatched URL lands here, signed in or not.' },
  'healthcheck.ts': { access: 'public', reason: 'Read by Docker and by Gatus, neither of which holds a session.' },

  // ── Helper modules that live under `app/routes/` ───────────────────────
  'legal/last-updated.ts': { access: 'module', reason: 'A date helper imported by the legal pages. Not a route.' },
  'legal/operator.ts': { access: 'module', reason: 'The operator details the legal pages render. Not a route.' },
  'legal/page-links.tsx': { access: 'module', reason: 'The shared cross-links between the legal pages. Not a route.' },

  // ── The enrichment endpoints a rendered page talks to ──────────────────
  'api.enrichment.$headwordId.ts': {
    access: 'public',
    reason: 'The read-only poll a pending panel drives. It reads the cache, it never enqueues, so it spends nothing.',
  },
  'api.enrichment-vote.ts': {
    access: 'gated-inline',
    reason: 'Its action calls `requireVoterAccount` first and answers 401 before any path that could reach `enqueueEnrichment` on a downvote.',
  },
  'api.v1.transcribe.ts': {
    access: 'gated-inline',
    reason: 'Its action reads the session first and answers a 401 refusal in JSON. A redirect would be unusable to the `fetch` that calls it.',
  },

  // ── The end-to-end-encrypted account and sync endpoints ────────────────
  'api.v1.auth.kdf.ts': {
    access: 'public',
    reason: 'Pre-login by definition, and it always answers 200: branching on whether the account exists would make it an enumeration oracle.',
  },
  'api.v1.auth.signup.ts': {
    access: 'gated-inline',
    reason: 'Public transport, gated by the INVITE rather than by a session (ADR-0009). `handleSignup` refuses 403 without an admitted token.',
  },
  'api.v1.auth.login.ts': { access: 'public', reason: 'Presents a credential. It is how a session is obtained, so it cannot require one.' },
  'api.v1.auth.recover.ts': { access: 'public', reason: 'Presents the recovery code, the second authenticator. Same reason as login.' },
  'api.v1.auth.recover-rotate.ts': { access: 'public', reason: 'Presents a recovery credential. Same reason as login.' },
  'api.v1.auth.refresh.ts': { access: 'gated-inline', reason: 'Authenticated by the refresh token in the session cookie, which it rotates.' },
  'api.v1.auth.logout.ts': { access: 'gated-inline', reason: 'Resolves the access token itself and revokes its family.' },
  'api.v1.auth.account.ts': { access: 'gated-inline', reason: 'Reads the session, and requires the `authHash` again before it will delete anything.' },
  'api.v1.auth.devices.ts': { access: 'gated-inline', reason: 'Reads the session and answers only about the account that holds it.' },
  'api.v1.sync.blob.ts': { access: 'gated-inline', reason: 'Reads the session. The blob is the encrypted vault of one account.' },
  'api.v1.sync.key-records.ts': { access: 'gated-inline', reason: 'Reads the session. The wrapped data keys belong to one account.' },

  // ── The bearer-token REST surface, inherited from ts-factory-stack ─────
  'api.v1.api-keys.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },
  'api.v1.api-keys.$id.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },
  'api.v1.admin.db.check.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },
  'api.v1.admin.db.pool.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },
  'api.v1.admin.db.tables.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },
  'api.v1.admin.db.describe.$table.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },
  'api.v1.admin.db.query.ts': { access: 'bearer-token', reason: 'requireSuperadminApiKey.' },

  // ── The operator screens under `/super/` ───────────────────────────────
  // What is left of the inherited admin surface. The org tree, `/dashboard`,
  // `/select-org`, `/create-org`, `/super/orgs` and `/super/users` were deleted
  // by M189 with their tables (ADR-0010), and `_auth.tsx` went with them.
  '_super.tsx': {
    access: 'gated-layout',
    reason: 'Carries `accountMiddleware` then `superadminMiddleware`. A top-level layout since M189: it no longer nests under `_auth`.',
  },
  'super/index-redirect.ts': { access: 'gated-layout', reason: 'Under `_super`. A hop from `/super` to `/super/llm`, refused before it runs for anyone who is not a superadmin.' },
  'super/llm.tsx': { access: 'gated-layout', reason: 'Under `_super`.' },
  'super/whoami-ip.tsx': { access: 'gated-layout', reason: 'Under `_super`.' },
} as const satisfies Record<string, RouteClassification>;

/** Every classified path, for the completeness test and for a reader counting them. */
export const CLASSIFIED_ROUTE_FILES: readonly string[] = Object.keys(ROUTE_CLASSIFICATION);

/**
 * The files an anonymous request can reach in full.
 *
 * `landing-loader-split` is deliberately NOT in here: half of that file is
 * public and half of it is not, and a list that called it either would be a
 * lie in one direction or the other.
 */
export const PUBLIC_ROUTE_FILES: readonly string[] = Object.entries(ROUTE_CLASSIFICATION)
  .filter(([, classification]) => classification.access === 'public')
  .map(([file]) => file);
