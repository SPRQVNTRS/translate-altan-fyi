# translate-altan-fyi

translate.altan.fyi is a vocabulary and translation web app. A user searches a word or a phrase and gets a translation, an explanation and example sentences, and can collect what they want to learn into lists. The app is MIT licensed and self-hostable, and it runs as one service: TypeScript, Vite, React Router v8, Express, Drizzle and pg-boss against one Postgres.

## Requirements

- Node.js ≥ 22
- PostgreSQL (Docker via `docker compose up` if you don't have one running)
- pnpm

## Quickstart

```bash
pnpm install

# Bring up Postgres. Skip this step if you already have a Postgres reachable
# at the host/port in your .env — the compose file is portable, not mandatory.
docker compose up -d

# Copy the example env and adjust as needed.
cp .env.example .env

# Apply the schema directly from drizzle/schema.ts to your dev DB.
pnpm drizzle:push

# Seed the dev DB.
pnpm drizzle:seed

# Start the dev server + background worker.
pnpm dev
```

The app is served at `http://localhost:${PORT}` (default `3000` per `.env.example`).

`pnpm dev` starts two processes in parallel — `dev:server` (Express + RR7 SSR) and `dev:worker` (the pg-boss workflow worker). Each can be run on its own with `pnpm run dev:server` or `pnpm run dev:worker`.

## Schema management: `push` for dev, migrations for prod

`drizzle/schema.ts` is the source of truth for the schema. This template intentionally ships **without** a migration history under `drizzle/migrations/` — your migration history is yours, not the framework's.

**Local development** — use `pnpm drizzle:push` to sync schema changes directly:

```bash
# Edit drizzle/schema.ts, then:
pnpm drizzle:push
```

No migration files generated; the DB is brought into shape immediately. This is the right workflow while a schema change is in flux.

**Production (or any tracked deploy)** — once you want a recorded history, generate your first migration:

```bash
pnpm drizzle:generate   # writes drizzle/migrations/0000_<name>.sql + meta/
pnpm drizzle:migrate    # applies any pending migrations
```

From that point on, `drizzle:migrate` becomes your deploy path and `drizzle:push` should only be used in throwaway environments.

`scripts/start.sh` runs `drizzle:migrate` on container start — that's a no-op when no migrations exist (an empty `meta/_journal.json` is shipped so the command succeeds cleanly), and applies pending migrations once you have any.

### Data migrations

Separate from schema migrations: **data migrations** are TypeScript files that perform bulk data changes (backfills, normalisations, one-shot fix-ups). They live in `drizzle/data-migrations/migrations/<YYYY-MM-DD>-<slug>.ts`, are tracked in a `data_migrations` table so each runs at most once per environment, and execute inside a transaction.

`scripts/start.sh` runs `pnpm cli data-migration run` after schema migrations, so they auto-apply on every deploy. See [`.adr/0002-data-migrations.md`](.adr/0002-data-migrations.md) for the rationale and the existing example file (`2026-05-13-noop-bootstrap.ts`) for the pattern.

## CLI

The CLI is a thin client over the same REST API the web UI uses. Set `TRANSLATE_API_KEY` (and optionally `--remote` / `--prod` for a remote server) and every command goes through HTTP auth, multi-tenancy enforcement, and audit.

```bash
pnpm cli api-key list --org=default
pnpm cli --remote=http://localhost:3000 workflow list --format=json
TRANSLATE_PROD_URL=https://app.example.com pnpm cli --prod org list
```

See [`.claude/cli.md`](.claude/cli.md) for the full command surface, and [`AGENTS.md`](AGENTS.md) for the API-first / CLI-wraps-API pattern.

## Configuration

Environment variables flow through `app/config/`. Import the `CONFIG` object for typed access:

```typescript
import { CONFIG } from '#config';

const port = CONFIG.server.port;
const dbUrl = CONFIG.database.url;
```

### Database connection pooling

The application uses PostgreSQL connection pooling via `pg.Pool`. Tunables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MAX` | `10` | Maximum number of connections |
| `DB_POOL_MIN` | `2` | Minimum connections to maintain |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle connection close timeout |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Connection acquisition timeout |

In production, pool statistics are logged every 60 seconds; a warning fires when `waitingCount > 5` (pool under pressure).

### Drizzle Kit with TypeScript packages

The `drizzle:*` scripts invoke `drizzle-kit` via `tsx` rather than directly:

```bash
tsx node_modules/drizzle-kit/bin.cjs push
```

This is required because Node.js doesn't strip TypeScript inside `node_modules` (see [`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`](https://nodejs.org/api/typescript.html)). Since the schema imports from internal TS-only packages (e.g. `@sprqvntrs/workflows/schema`), `tsx` handles those during introspection.

## Accounts and the encrypted personal layer

The app is **anonymous by default**. Search, vocabulary lists and history all
work with no account, stored on the device. There is no signup prompt, and
nothing on those paths requires an account.

An account exists for exactly one reason: syncing to a second device. It is
offered in one place, a card on `/settings`.

When a user opts in, their personal data is **end to end encrypted**:

- The browser derives an Argon2id key from a passphrase, then splits it into two
  independent HKDF branches. One is the key-encryption key that wraps the data
  key. The other is an auth hash.
- The server stores only `HMAC(pepper, authHash)`, with the pepper held outside
  the database in `SERVER_SECRET`. It never sees the passphrase, the
  key-encryption key or the data key, so it cannot decrypt anything. That is a
  property of the construction, not a policy.
- Accounts are identified by an opaque **handle**, not an email address. The
  service stores no email, so there is no verification mail and no reset link.
- Recovery is a **recovery code**, which is a second authenticator that wraps the
  same data key under its own key. It is shown once and must be retyped before
  setup completes, because a code you were shown and never typed is a code you
  do not have.

**Nobody can restore access.** If the passphrase and the recovery code are both
lost, that account's synced data is unrecoverable. There is no operator override,
because there is no key to override with.

The protocol is specified in [`PROTOCOL.md`](PROTOCOL.md) and the implementation
is copied from `openplate-sync` rather than shared, for the reasons in
[ADR-0008](.adr/0008-e2ee-sync-copied-not-extracted.md).

Set `SERVER_SECRET` in every deployed environment. See `.env.example` for what it
is, what it is not, and why rotating it is a breaking change.

## Multi-tenancy

The app supports multi-tenant deployments with organization-based isolation enforced in **application code** via a typed query wrapper (`tenantDb(ctx)` from `#drizzle/tenant-db`). Postgres RLS is **not** used — see [`.adr/0003-app-enforced-multi-tenancy.md`](.adr/0003-app-enforced-multi-tenancy.md) for the rationale.

### Key features

- **Wrapper-enforced isolation:** every read/write against a tenant-scoped table goes through `tenantDb(ctx)`, which auto-injects `organization_id` on inserts and ANDs it into the WHERE clause on selects/updates/deletes.
- **Path-based routing:** organization context comes from the `/org/:orgSlug/*` URL pattern via `tenantMiddleware` and `getTenant(context)`.
- **Flexible membership:** users can belong to multiple organizations with different roles.
- **Superadmin access:** platform administrators access all organizations via dedicated `/super/*` routes that use `getRawDb()`; API-key superadmin keys bypass `assertOrgAccess`. The flag itself lives on `accounts.is_superadmin` and is granted with `pnpm cli account grant-superadmin <handle>`.

See [`.claude/skills/tenant-safe-db/SKILL.md`](.claude/skills/tenant-safe-db/SKILL.md) for full patterns and migration notes.

### Organization roles

| Role | Access |
|------|--------|
| Owner | Full control including org deletion |
| Admin | Manage members and settings |
| Member | Standard access |
| Viewer | Read-only |

### Single-tenant mode

For deployments that don't need multi-tenancy, create one organization at startup and auto-assign new users to it. Optionally redirect `/select-org` directly to `/org/:orgSlug/dashboard`. The schema doesn't change between modes.

### When to put RLS back

The wrapper assumes this app's server is the only writer to Postgres. If you expose the DB directly — BI tools with shared credentials, PostgREST/Hasura, customer-facing SQL, or LLM agents writing arbitrary queries — re-introduce RLS for the exposed tables. The wrapper does not protect against actors that bypass it.

## Architecture decisions

Significant choices are recorded as ADRs in [`.adr/`](.adr/). Read them before changing the corresponding area, and write a new one when making a similar-impact decision.

| # | Title |
|---|-------|
| [0001](.adr/0001-cli-wraps-the-api.md) | CLI wraps the API |
| [0002](.adr/0002-data-migrations.md) | Data migrations alongside schema migrations |
| [0003](.adr/0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS) |
| [0004](.adr/0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint |
| [0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint + anti-slop is the lint gate |
| [0007](.adr/0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 |
| [0008](.adr/0008-e2ee-sync-copied-not-extracted.md) | The E2EE sync code is copied from openplate-sync, not shared |

## Tests

```bash
pnpm typecheck            # react-router typegen && tsc
pnpm lint                 # oxlint --max-warnings 0
pnpm test:integration     # node --test against the live dev server
```

The integration suite (`tests/integration/`) spawns CLI subcommands against a running server and asserts the responses. Each test skips gracefully when `TEST_API_KEY` is not set, so the suite is safe to run in environments without seeded credentials.

For commands that require a superadmin key (`user list`, `db check`), `TEST_API_KEY` must reference a key created by a superadmin. Superadmin is `accounts.is_superadmin`, granted with `pnpm cli account grant-superadmin <handle>`.

## Building for production

```bash
pnpm build       # react-router build (NODE_ENV=production)
pnpm start       # react-router-serve ./build/server/index.js
```

The Dockerfile (`Dockerfile.pnpm`) builds the image and uses `scripts/start.sh` as the entrypoint — it sequences `drizzle:migrate` → `data-migration run` → `start`. Before the first deploy, generate your first migration locally (`pnpm drizzle:generate`) so the deploy has something to apply against the production DB.

## More

- [`AGENTS.md`](AGENTS.md) — full coding guidelines and the four-layer pattern for adding new endpoints. AI coding agents (Claude, Codex, Cursor) read this file by convention; [`CLAUDE.md`](CLAUDE.md) imports it.
- [`.claude/cli.md`](.claude/cli.md) — every CLI subcommand
- [`.claude/workflows.md`](.claude/workflows.md) — the workflow / orchestrator system
- [`.tracker/`](.tracker/) — implementation tracker for ongoing work
