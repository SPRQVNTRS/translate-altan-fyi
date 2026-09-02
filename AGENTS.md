# Repository Guidelines

## Project Structure

- `app/` — routes, components, models, utilities, workflows
- `drizzle/` — database schema, migrations, tenant query wrapper
- `cli/` — Laravel-style management commands
- `server.ts` — Express + React Router v8 SSR entry (dev **and** production; see [ADR-0004](.adr/0004-custom-server-is-the-production-entry.md))
- `.claude/` — AI assistant rules, skills, and commands
- `tools/oxlint/anti-slop/` — vendored third-party lint plugin, MIT (do not edit; provenance in [tools/oxlint/README.md](tools/oxlint/README.md))
- `.githooks/` — pre-commit lint gate and pre-push test gate, installed by the `prepare` script

## Prerequisites

The four `@sprqvntrs/*` dependencies are published to npmjs and need no
credentials. `.npmrc` pins the scope to `https://registry.npmjs.org/` so an
install still works on a machine whose `~/.npmrc` routes the scope to GitHub
Packages.

There is no cloud CI test runner. `.githooks/pre-push` is the only gate, by
workspace policy: a push from the workstation is what triggers the deploy, so
the tests belong in front of it.

Install the gate once per clone: `make hooks` from the workspace root, or
`pnpm install` (the `prepare` script sets `core.hooksPath`).

## Commands

```bash
pnpm dev          # Dev server (requires: docker compose up)
pnpm build        # Production build
pnpm typecheck    # Type check (never run tsc without --noEmit)
pnpm lint         # oxlint (anti-slop + correctness + import guardrails)
pnpm lint:fix     # oxlint auto-fixable subset
pnpm cli          # CLI commands (see .claude/cli.md)
```

## Linting

**oxlint is this repo's linter.** It runs oxlint's own correctness/suspicious/perf
catalog *and* [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) in a
single pass over `.oxlintrc.json` — oxlint's default config path, so a bare
`oxlint` (editor extension, `--fix`, ad-hoc run) picks up the full gate with no
flags. It is the *only* linter: ESLint and typescript-eslint were removed once
their last job, the cross-variant `no-restricted-imports` guardrails, moved into
`.oxlintrc.json` `overrides` — which is also what unblocked TypeScript 7
([ADR-0007](.adr/0007-one-linter-and-typescript-7.md)).

**Editing the `overrides` globs:** oxlint matches `files` against the full path,
so every glob needs a `**/` prefix. A bare `app/**/*.ts` silently matches
nothing — no error, it just never applies.

**All 15 anti-slop rules run at `error`.** The plugin is a vendored copy of
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT) living under
`tools/oxlint/anti-slop/` and loaded via `jsPlugins` — it is not an npm
dependency, and upstream publishes none. Source, pinned commit, drift check, and
re-vendor procedure: [tools/oxlint/README.md](tools/oxlint/README.md). Do not
edit the vendored tree, and do not downgrade a rule to clear a finding; fix the
code.

Why the gate is this blunt, and why the boundary helpers below exist in the
shapes they do: [ADR-0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md).

### Where the gate runs

| Surface | What runs | Wiring |
|---------|-----------|--------|
| Editor | oxlint on type, `source.fixAll.oxc` on save | `.vscode/settings.json` + the `oxc.oxc-vscode` recommendation |
| Claude Code | oxlint on each written/edited file; a finding blocks with the diagnostic | `.claude/hooks/lint-edited-file.sh` (PostToolUse) |
| Commit | oxlint on staged files | `.githooks/pre-commit`, installed by the `prepare` script — no husky, no setup step |
| Push | full-tree oxlint → typecheck → unit tests → content validate → build | `.githooks/pre-push`, the repo's only test gate — there is no cloud CI |

`git commit --no-verify` skips the commit hook; pre-push lints the whole tree
anyway. `SKIP_TESTS=1 git push` skips the push gate and pushes unverified code —
use it deliberately, and say so.

### Rules deliberately disabled

Seven of oxlint's built-in rules are `off` in `.oxlintrc.json`. Each is
inapplicable to this stack rather than inconvenient — the reason matters if you
are tempted to re-enable one:

| Rule | Why off |
|------|---------|
| `react/react-in-jsx-scope` | Automatic JSX runtime (React 19 + Vite). The rule predates it. |
| `unicorn/no-instanceof-builtins` | It wants `typeof x === 'function'`, which `anti-slop/no-runtime-typeof` bans. `instanceof Function` is the callable check the stricter gate leaves open. |
| `import/no-named-as-default-member` | Fires on `pg.Pool` / `bcrypt.hash`. The default-namespace form is the correct CJS-interop idiom for these packages. |
| `import/no-unassigned-import` | `import 'dotenv/config'` is the documented usage. |
| `eslint/no-await-in-loop` | Migrations, seeds, and retry backoff are sequential *by design*; the rule pushes toward incorrect parallelization. |
| `eslint/no-underscore-dangle` | `__workflowOrchestrator` and friends are deliberate `globalThis` singletons that survive HMR. |
| `jsx-a11y/control-has-associated-label` | Fires on `<tr>` elements, which are not controls. Real label problems are still caught by `label-has-associated-control`, which stays on. |

Also not enabled: the `react-perf` plugin, which flags every inline handler
passed to a plain DOM element. It is built for memoized component trees and
produces no signal here.

### What the anti-slop rules ask for, and how this repo answers

| Rule | The fix |
|------|---------|
| `no-runtime-typeof` | Parse the value with a Zod schema at the I/O boundary, then branch on the decoded domain value. |
| `no-unknown-parameters` / `no-unknown-returns` | Name a domain type. A parameter genuinely holding a caught error may be named `cause` — that is the rule's own exemption. |
| `no-unsafe-dictionary-type` | Use `JsonValue` / `JsonObject` from `#app/lib/json`, or a schema-derived type. |
| `no-known-value-widening` | Drop the annotation and use `satisfies` so the literal types survive. |
| `require-safety-comment-for-type-assertion` | Prefer removing the assertion. Where TypeScript genuinely cannot express the invariant (Drizzle generic erasure, CSS custom properties, cross-package type identity), write a `// SAFETY:` comment immediately above the assertion or its containing statement stating what makes it sound. |

The boundary helpers that exist so you rarely need an assertion:

- `parseJsonBody(request, schema)` — `#app/lib/api-auth.server`, for request bodies
- `transport.get(path, schema, params)` — `cli/lib/transport`, for every CLI call
- `cli/lib/schemas.ts` — response schemas derived from the Drizzle tables via `drizzle-zod`
- `asTenantRows(table, rows)` / `asTenantRow(table, row)` — `#drizzle/tenant-db`
- `workflowOrgId(context)` — `#app/models/workflows.server`, the one decode of workflow tenancy

## Key Documentation

| Topic | Location |
|-------|----------|
| TypeScript | [.claude/typescript-rules.md](.claude/typescript-rules.md) |
| React | [.claude/react-rules.md](.claude/react-rules.md) |
| React Router v8 | [.claude/react-router-rules.md](.claude/react-router-rules.md), [skill](.claude/skills/react-router-framework-mode/SKILL.md) |
| Forms (Conform + Zod v4) | [.claude/conform-to-react.md](.claude/conform-to-react.md) |
| Workflows | [.claude/workflows.md](.claude/workflows.md) |
| CLI | [.claude/cli.md](.claude/cli.md) |
| Tenant-safe DB | [.claude/skills/tenant-safe-db/SKILL.md](.claude/skills/tenant-safe-db/SKILL.md) |
| Architecture Decisions | [.adr/README.md](.adr/README.md) |

## Architecture Decision Records (ADRs)

Significant decisions — anything that constrains future work, locks in a trade-off, or would surprise a new contributor — are recorded as ADRs in [`.adr/`](.adr/). Read them before proposing a change that touches the same area; if you're making a new big-call decision, write a new ADR in the same conversation.

**When to write an ADR:**
- Adopting or dropping a framework, runtime, or major library
- Cross-cutting architectural patterns (auth model, tenancy enforcement, transport layer)
- Decisions that take effort to reverse (DB schema shape, file layout, public API contracts)
- "Why didn't you just X?" answers that future-you will forget

**Workflow:** copy `.adr/0000-template.md` to the next zero-padded number, fill in `Status`, `Context`, `Decision`, `Consequences`, then add the entry to the index below and to `.adr/README.md`.

### Index

| # | Title | Status |
|---|-------|--------|
| [0001](.adr/0001-cli-wraps-the-api.md) | CLI wraps the API | Accepted |
| [0002](.adr/0002-data-migrations.md) | Data migrations alongside schema migrations | Accepted |
| [0003](.adr/0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS) | Accepted |
| [0004](.adr/0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint | Accepted |
| [0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint + anti-slop is the lint gate | Accepted |
| [0007](.adr/0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 | Accepted |

## Coding Style Summary

- **TypeScript**: Strict types, no `any`, use Zod inference
- **Files**: `kebab-case.ts/tsx`; routes use `_layout.tsx` patterns
- **React**: Avoid `useEffect` for derived state; prefer early returns over nested ternaries
- **Drizzle**: Use `Select*` types in UI, `Insert*` for mutations

## API-First — CLI wraps the API

**Rule:** new functionality lands in the HTTP API first; the CLI is a thin client over that API. Never add a CLI subcommand that talks to the DB or business logic directly when an API call could do the same work.

**Why:**
- Single code path for web UI, CLI, third-party clients, and LLM agents — no drift
- HTTP layer carries auth, multi-tenancy enforcement, and audit on every operation
- Prod CLI calls don't require DB credentials on the operator's machine
- Remote agents can act on prod via `--remote=<url>` + scoped API keys

**Bootstrap-only exceptions** (direct-DB allowed because they precede the auth surface itself):
- `api-key create` — bootstrap the first key for a fresh environment
- `user create`, `org create` — bootstrap the first superadmin / org
- `db check`, `db migrate`, `db reset` — DB-level health and lifecycle, run before the API is up

These are enumerated in [ADR-0001](.adr/0001-cli-wraps-the-api.md). Don't add to the list without an ADR amendment.

See `.adr/0001-cli-wraps-the-api.md` for the full rationale. The four-layer pattern in the next section is the canonical recipe for adding any non-bootstrap feature.

### Adding a new endpoint (the four-layer pattern)

Every non-bootstrap feature touches four files. Doing all four keeps `--remote` HTTP mode, direct-DB CLI mode, and the web/agent surface in sync.

**Layer 1 — Model** (`app/models/<resource>.server.ts`)

The business-logic primitive. Tenant-scoped tables go through `tenantDb({orgId})`; cross-tenant queries use `getRawDb()` with an explicit `tdb.scope(table)` filter. List functions return `{ rows, total }` with a real `COUNT(*)` run in parallel (use the pattern in `app/models/api-keys.server.ts:listApiKeys`).

```typescript
export async function listFoos(
  ctx: TenantCtx,
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectFoo[]; total: number }> {
  const tdb = tenantDb(ctx);
  const [rows, totalRow] = await Promise.all([
    tdb.select(foos).orderBy(desc(foos.createdAt))
       .limit(pagination.limit).offset(pagination.offset),
    getRawDb().select({ value: count() }).from(foos)
       .where(tdb.scope(foos)).then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}
```

**Layer 2 — HTTP route** (`app/routes/api.v1.<resource>.ts`, registered in `app/routes.ts`)

Use the shared auth helpers from `app/lib/api-auth.server.ts`:
- `requireApiKey(request)` — returns `{ apiKey, ctx, isSuperadmin: false }` after revoked-key check.
- `requireSuperadminApiKey(request)` — same but enforces the creating user is a superadmin (`isSuperadmin: true`). Use for cross-tenant / global views.
- `assertOrgAccess(auth, orgId)` — throws 403 unless the key belongs to the org or is superadmin (superadmin keys always bypass).
- `jsonError(status, message)` — always `throw jsonError(...)`. Returns the standard `{ error, code }` JSON envelope.
- `resolveOrgSlug(slug)` — slug → orgId, or 404.

List endpoints use `parsePaginationParams(url.searchParams)` + `paginatedJson({data, total, limit, offset})` from `app/lib/pagination.server.ts` for a uniform envelope and clamped limits (default 20, max 100).

```typescript
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url);
  const auth = await requireApiKey(request);
  const orgId = await resolveOrgSlug(url.searchParams.get('org') ?? '');
  assertOrgAccess(auth, orgId);

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listFoos({ orgId }, pagination);
  return paginatedJson({ data: rows, total, ...pagination });
}
```

**Cross-tenant (no `?org=` filter, global view):** call `requireSuperadminApiKey(request)` first, then issue the query via `getRawDb()` — that's the only place the wrapper is bypassed legitimately. Pattern lives in `app/routes/api.v1.metric-events.ts`.

**Layer 3 — DirectTransport handler** (`cli/lib/direct-transport-handlers.ts`)

Register a handler with the same path/method/shape as the HTTP route. This is what runs when the CLI is invoked without `--remote` (the default for local dev). All registrations live in one file — do **not** scatter `direct.register(...)` calls across command files.

```typescript
direct.register('GET', '/api/v1/foos', async ({ query }) => {
  const pagination = parsePaginationParams(query);
  const orgId = await resolveOrgSlug(typeof query.org === 'string' ? query.org : '');
  const { rows, total } = await listFoos({ orgId }, pagination);
  return { data: rows, total, ...pagination };
});
```

**Layer 4 — CLI command** (`cli/commands/<resource>.ts`)

Flat file under `cli/commands/`. Only `data-migration/` is nested today; everything else is one file per resource group. The command imports the `transport` live-binding singleton from `cli/lib/transport.ts` and calls `transport.get(path, params?)` — never `instanceof` the transport, use `isHttpTransport(t)` from `transport.ts` if you must branch.

```typescript
import { transport } from '../lib/transport';

async function listFoosCmd(options: { format: OutputFormat; org: string; limit: string; offset: string }) {
  const response = await transport.get('/api/v1/foos', {
    org: options.org,
    limit: parseInt(options.limit, 10),
    offset: parseInt(options.offset, 10),
  });
  const envelope = response as PaginatedResult<SelectFoo>;
  output(options.format, envelope.data, fooColumns, {
    total: envelope.total, limit: envelope.limit, offset: envelope.offset,
  });
}
```

Document the new command in [.claude/cli.md](.claude/cli.md).

### Hiding secret columns from API responses

If a tenant-scoped table holds a credential artifact (hash, token, encrypted blob), never let it cross the route boundary. Pattern from `app/models/api-keys.server.ts`:

1. Export a `SelectFooPublic = Omit<SelectFoo, 'secretField'>` type from the model.
2. Define a `fooPublicColumns` Drizzle projection that lists every column except the secret.
3. Use `getRawDb().select(fooPublicColumns).from(foos).where(tdb.scope(foos))…` for reads.
4. For `UPDATE … RETURNING`, follow the update with a `SELECT fooPublicColumns` to fetch the post-update row without the secret.
5. Every public-facing function returns `SelectFooPublic` (or `{ rows: SelectFooPublic[], total }` for lists). The secret column is read only inside the model, only for WHERE-clause matching during auth.

The downstream types (`ApiKeyAuth.apiKey`, formatters, CLI columns) all reference the public type — there's no path for the secret to leak via inference.


## Calling the CLI against production

With all commands migrated to HTTP, an LLM agent or human operator can act on production data using only an API key — no database credentials required.

### Creating the first API key

The first key must be created via direct-DB access (bootstrap exception per ADR-0001):

```bash
pnpm cli api-key create --org=<slug> --name="agent-key"
# Outputs: sk_...  (copy this value)
```

### Using the key

```bash
export TRANSLATE_API_KEY=sk_<your-key>

# Against a specific server
pnpm cli --remote=http://localhost:3456 workflow list
pnpm cli --remote=https://app.example.com org list
pnpm cli --remote=https://app.example.com db check
```

### `--prod` shorthand

Set `TRANSLATE_PROD_URL` in your environment and use `--prod` instead of `--remote`:

```bash
export TRANSLATE_PROD_URL=https://app.example.com
pnpm cli --prod workflow list
```

### Key scopes

| Key type | What it can access |
|----------|-------------------|
| **Org-scoped** (created for a specific org) | api-key, data-source, metric-event, workflow, org operations scoped to that org |
| **Superadmin** (created by/for a superadmin user) | user management, db admin, cross-org revoke, all org operations |

### Example commands

```bash
# Workflows
pnpm cli --prod workflow list --format=json
pnpm cli --prod workflow stats

# API keys
pnpm cli --prod api-key list --org=default

# Database (superadmin key required)
pnpm cli --prod db check
pnpm cli --prod db tables
```

### Safety note

CLI commands sent via `--remote` go through the app's HTTP auth layer — auth is enforced, tenant isolation is enforced, and all operations are auditable. No raw database access is required on the operator's machine.

## Data Migrations

Schema migrations (`drizzle/migrations/`) change the shape of the DB. **Data migrations** change the contents — backfills, enrichments, one-time fix-ups, repopulating denormalized columns. They live alongside schema migrations and run automatically on deploy.

**Key properties:**
- Tracked in a `data_migrations` table (name + applied_at) so each runs at most once per environment
- Discovered from `drizzle/data-migrations/<YYYY-MM-DD>-<slug>.ts` at startup
- Each migration is an async function that receives a DB handle and runs inside a transaction
- Run by `pnpm cli data-migration run` (deploy invokes this after schema migrations)

**When to write one:**
- Backfilling a new NOT-NULL column on existing rows
- Renaming/normalizing values in bulk
- Repopulating denormalized data after a schema change
- Any one-shot bulk write you'd otherwise be tempted to run as an ad-hoc psql script

See [ADR-0002](.adr/0002-data-migrations.md) for the rationale.
Runner: `drizzle/data-migrations/runner.ts`
CLI: `cli/commands/data-migration/run.ts`
Migrations: `drizzle/data-migrations/migrations/<YYYY-MM-DD>-<slug>.ts`

## Multi-Tenancy (CRITICAL)

Tenant isolation is enforced in **application code** via `tenantDb(ctx)` from `#drizzle/tenant-db`. Postgres RLS is **not** used. See [tenant-safe-db skill](.claude/skills/tenant-safe-db/SKILL.md) for the full rationale and patterns.

The two-rule version:

1. **Tenant-scoped tables** (`articles`, `pages`, `categories`, `metricEvents`, `apiKeys`, `dataSources`) — only access via `tenantDb({ orgId })`. The wrapper auto-injects the `organization_id` filter on every read/write.

2. **Global tables** (`users`, `organizations`, `organizationMembers`) and **cross-tenant lookups** — use `getRawDb()` from `#drizzle/tenant-db`. Loud name on purpose; grep-able in code review.

```typescript
import { tenantDb, getRawDb } from '#drizzle/tenant-db';

// Routes — tenant comes from tenantMiddleware via getTenant(context)
const tenant = getTenant(context);
const tdb = tenantDb({ orgId: tenant.orgId });

await tdb.insert(articles, { title, slug, content, authorId: user.id });
// organizationId is auto-stamped — caller MUST NOT pass it

const rows = await tdb.select(articles).orderBy(desc(articles.createdAt));

// Complex joins use getRawDb() + tdb.scope(table) for the org filter:
await getRawDb()
  .select({ id: articles.id, authorName: users.name })
  .from(articles)
  .leftJoin(users, eq(articles.authorId, users.id))
  .where(tdb.scope(articles))
  .orderBy(desc(articles.createdAt));
```

**NEVER** call `getRawDb()` against a tenant-scoped table without `.where(tdb.scope(table))`. There is no DB-level safety net — code review and the wrapper API surface are the entire defense.

**When to put RLS back**: if anything other than this app's server code can issue SQL against the DB — BI tools with shared credentials, PostgREST/Hasura exposing Postgres directly, customer-facing SQL analytics, LLM agents writing queries — re-introduce RLS for those tables. The current model assumes the application is the only writer.

## Commits

Use Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`

See: [.claude/commands/commit.md](.claude/commands/commit.md)

## Claude Code Integration

```
.claude/
├── commands/       # /commit, /sync-cli
├── skills/         # cli-sync, form-persistence, tenant-safe-db, react-router-framework-mode
├── hooks/          # Post-edit validations (see below)
└── *.md            # Coding standards
```

`PostToolUse` hooks run on every `Write`/`Edit`:

| Hook | What it does |
|------|--------------|
| `lint-edited-file.sh` | Runs oxlint on the edited file. A finding **blocks** with the diagnostic, so slop is corrected in the same turn rather than at commit time. |
| `on-schema-change.sh` | Reminds you to generate a migration after a `drizzle/schema.ts` edit. |
| `validate-tenant-context.sh` | Flags `getRawDb()` against a tenant-scoped table without `tdb.scope(table)`. |

If a lint hook blocks you: fix the code. Do not downgrade the rule, and do not
add a suppression comment — see [ADR-0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md).
