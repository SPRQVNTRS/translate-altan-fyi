# translate.altan.fyi

A vocabulary and translation web app. You type a word or a phrase. The app
returns a translation, a plain explanation, and example sentences. You can
collect terms into learning lists. The app works without an account. Search,
lists, and history stay on your local device. An account serves one purpose:
syncing data to a second device. When you create an account, the app encrypts
your personal data end to end. The hosted instance lives at
[translate.altan.fyi](https://translate.altan.fyi). This repository contains the
entire codebase under the MIT licence. You can host it yourself.

## Architecture in five lines

1. One service. TypeScript, Vite, React Router v8, and Express run in a single
   process, with a second process for background tasks.
2. Postgres is the only datastore. Drizzle manages the schema and migrations.
3. pg-boss manages background jobs, and `worker.ts` runs them.
4. The encrypted personal zone code comes directly from `openplate-sync` instead
   of an external package, as explained in
   [ADR-0008](.adr/0008-e2ee-sync-copied-not-extracted.md).
5. The dictionary uses open data: Wikidata lexicographical entries (CC0) and
   Tatoeba sentences (CC0 and CC BY 2.0 FR). The `sources` table stores
   attribution data.

## Self-hosting

### What you need

- Node.js 22 or newer. The `.nvmrc` file specifies version 24 for development,
  and the production image (`Dockerfile.pnpm`) runs on version 22.
- pnpm 11. The repository sets this in `packageManager`, so
  [corepack](https://nodejs.org/api/corepack.html) installs the correct version
  automatically.
- PostgreSQL 15 or newer, with the `pg_trgm` extension enabled. Search uses
  trigram similarity, which measures text overlap, for the "did you mean"
  feature.

You do not need a private registry token. All four `@sprqvntrs/*` dependencies
exist on npmjs.com under the MIT licence. The `.npmrc` file routes this scope
directly to `https://registry.npmjs.org/`. Installs work even if your global
`~/.npmrc` file redirects the scope.

These packages publish uncompiled TypeScript. Because of this, `vite.config.ts`
includes them in `ssr.noExternal`. Vite compiles these dependencies instead of
passing them directly to Node.

### Install and run

```bash
git clone https://github.com/SPRQVNTRS/translate-altan-fyi.git
cd translate-altan-fyi
pnpm install

# Install the pre-push gate. A fresh clone has none until this runs.
make hooks   # or: pnpm install, whose `prepare` script sets core.hooksPath

# Bring up a Postgres. Skip this if you already have one.
docker compose up -d

cp .env.example .env
# Edit .env. At minimum set the DB_* variables. SESSION_SECRET and SERVER_SECRET
# are required in production and have development defaults otherwise.

pnpm drizzle:migrate   # create the schema
pnpm dev               # dev server and worker together
```

The app runs at `http://localhost:${PORT}`, which defaults to `3000`.

The `pnpm dev` command starts two processes: `dev:server` (Express running React
Router SSR) and `dev:worker` (the pg-boss job processor). You can run each
process separately with `pnpm run dev:server` or `pnpm run dev:worker`.

### Migrations and the worker in a deployment

The container entrypoint script is `scripts/start.sh`. It executes three tasks
in sequence:

1. It applies pending schema migrations with `pnpm drizzle:migrate`.
2. It runs pending data migrations with `pnpm cli data-migration run`. These
   one-time TypeScript scripts are tracked in a `data_migrations` table. See
   [ADR-0002](.adr/0002-data-migrations.md).
3. It boots the web process and the **worker** process together, monitoring
   both. If either process crashes, the entire container shuts down to force a
   full restart.

You must run the worker process. Word enrichment tasks depend on pg-boss queues.
If no worker processes those tasks, page requests will hang indefinitely.

Build and run the container image:

```bash
docker build -f Dockerfile.pnpm -t translate-altan-fyi .
docker run --env-file .env -p 3000:3000 translate-altan-fyi
```

To run outside Docker, build with `pnpm build`. Start the web server with `pnpm
start`, and start the worker with `pnpm worker`. You must run `pnpm
drizzle:migrate` manually before your first run.

## The seed dump

You can populate the database quickly without processing raw dumps. Building the
dictionary from scratch requires downloading large dumps from Wikidata and
Tatoeba, which takes hours. Instead, you can use a pre-built seed dump of the
shared dictionary tables:

- **Download:**
  [`dictionary-seed-2026-09-02.dump`](https://github.com/SPRQVNTRS/translate-altan-fyi/releases/download/seed-2026-09-02/dictionary-seed-2026-09-02.dump)
  (45 MB, custom pg_dump format), with an [md5
  checksum](https://github.com/SPRQVNTRS/translate-altan-fyi/releases/download/seed-2026-09-02/dictionary-seed-2026-09-02.dump.md5)
  file.
- **Generated:** 2026-09-02.
- **Contents:** 383,185 headwords, 102,335 senses, 107,085 sense versions, 1,862
  translations, 99,744 example sentences, 829,264 example-to-headword links, and
  4 `sources` rows.

### Licence and attribution

The seed dump includes data from three sources. The application presents
attribution directly from the `sources` table:

| Source | Licence | What it is |
|--------|---------|------------|
| Wikidata lexicographical data | CC0 1.0 | headwords, senses, glosses |
| Tatoeba (CC0 sentences) | CC0 1.0 | example sentences |
| Tatoeba | CC BY 2.0 FR | example sentences |

**The CC BY 2.0 FR records require clear attribution.** If you publish this
data, you must credit Tatoeba and link to the source sentence. The app does this
automatically through the `attribution` column. Keep the `sources` records in
your database and keep the UI attributions intact to stay compliant.

### Restore

The seed dump contains table rows without any schema definitions. Run database
migrations first, then run these commands:

```bash
curl -LO https://github.com/SPRQVNTRS/translate-altan-fyi/releases/download/seed-2026-09-02/dictionary-seed-2026-09-02.dump
scripts/dictionary-restore.sh --truncate-first dictionary-seed-2026-09-02.dump
```

The script uses your existing `DB_*` environment variables. It uses
`--single-transaction` during restore. This flag is critical: without it,
`pg_restore --data-only` can return an exit code of 0 even when all rows fail to
load. The `--truncate-first` flag clears the nine dictionary tables before
loading. This cleanup prevents conflicts with migration scripts that insert an
initial `sources` row. The restore command requires database superuser access
because it uses `--disable-triggers`.

The import takes several minutes. Verify the imported row counts directly
instead of relying on exit codes:

```bash
psql -d "$DB_NAME" -c 'SELECT count(*) FROM headwords;'
```

The `scripts/verify-seed-restore.sh` script tests this process against a
temporary database and outputs record counts. The `scripts/make-seed-dump.sh`
script exports a new seed dump from your current database instance.

## Language model provider

The application can generate explanations and example sentences via a language
model through [OpenRouter](https://openrouter.ai). This feature is **optional**.
Add `OPENROUTER_API_KEY` to your `.env` file to enable it. Without this key, the
application works normally using local dictionary data: translations, senses,
and imported Tatoeba examples. Entries show less text, but pages load cleanly
without errors.

The UI identifies generated text clearly. It links AI text to the `Generated
explanations` source so users can distinguish it from imported database entries.

The system enforces spending limits. The `app_settings` table stores daily
spending caps alongside warning thresholds. When spending exceeds these
thresholds, the system sends an HTTP POST request to `ALERT_WEBHOOK_URL`. If you
do not configure a webhook, the system logs alerts to standard output.

## Configuration

The `.env.example` file outlines every supported variable with commentary and
placeholder values. Application configuration logic lives in `app/config/`.
Check that directory and `.env.example` for details.

```typescript
import { CONFIG } from '#config';

const port = CONFIG.server.port;
const dbUrl = CONFIG.database.url;
```

Review two important secrets before deploying:

- `SESSION_SECRET` encrypts and signs the user session cookie.
- `SERVER_SECRET` forms the root key for the encrypted personal storage layer.
  It cannot decrypt stored content. However, changing this value invalidates all
  stored authentication verifiers, forcing all users to run account recovery.
  The `.env.example` file describes this behavior.

### Database connection pooling

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MAX` | `10` | Maximum number of connections |
| `DB_POOL_MIN` | `2` | Minimum connections to maintain |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle connection close timeout |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Connection acquisition timeout |

In production environments, the application logs connection pool metrics every
60 seconds. It logs a warning whenever `waitingCount > 5`.

### Schema changes

The `drizzle/schema.ts` file acts as the single source of truth for the database
schema. Run `pnpm drizzle:push` to test local schema modifications. Run `pnpm
drizzle:generate` and `pnpm drizzle:migrate` to create and save migration files.
Production deployments run only `drizzle:migrate`.

The `drizzle:*` npm scripts execute `drizzle-kit` via `tsx`. Node does not strip
TypeScript inside `node_modules`, and the database schema imports types from
TypeScript packages.

## Accounts and the encrypted personal layer

The application is **anonymous by default**. Search, word lists, and history
save locally on your device without an account. The UI presents no signup
prompts, and core routes require no login.

Accounts exist only to sync state across multiple devices. Users can create an
account from a single settings card at `/settings`.

When a user enables sync, the system protects their data with **end-to-end
encryption**:

- The browser derives an Argon2id key from a passphrase. It splits this key into
  two separate branches using HKDF, a key derivation function. One branch acts
  as a key-encryption key to wrap the user data key. The other branch serves as
  an authentication hash.
- The server stores only `HMAC(pepper, authHash)`. The pepper resides outside
  the database in `SERVER_SECRET`. The server never receives the passphrase, the
  key-encryption key, or the raw data key. The server cannot read decrypted user
  data by cryptographic design.
- The system identifies accounts using an opaque **handle** rather than an email
  address. The database stores no email records, so the app provides no
  verification emails or password reset links.
- Users recover accounts with a **recovery code**. This code serves as an
  alternate authenticator that encrypts the same underlying data key. The UI
  displays this code once. The user must re-enter the code before finishing
  setup, ensuring they have saved it.

**Lost credentials cannot be restored.** If a user loses both their passphrase
and their recovery code, their synced data is permanently inaccessible.
Operators cannot restore access because the server holds no recovery keys.

[`PROTOCOL.md`](PROTOCOL.md) documents the complete sync protocol. The system
imports this implementation directly from `openplate-sync`, as documented in
[ADR-0008](.adr/0008-e2ee-sync-copied-not-extracted.md).

## CLI

The CLI communicates with the same HTTP REST API that powers the web interface.
Provide a `TRANSLATE_API_KEY` to run commands through standard HTTP
authentication, tenant checks, and audit logging.

```bash
pnpm cli api-key list --org=default
pnpm cli --remote=http://localhost:3000 workflow list --format=json
TRANSLATE_PROD_URL=https://app.example.com pnpm cli --prod org list
```

See [`.claude/cli.md`](.claude/cli.md) for full command documentation, and see
[`AGENTS.md`](AGENTS.md) for API conventions.

## Multi-tenancy

The application supports multi-tenant deployments. It isolates organization data
in **application code** using a typed query wrapper named `tenantDb(ctx)` from
`#drizzle/tenant-db`. It does **not** use Postgres Row-Level Security (RLS).
Read [ADR-0003](.adr/0003-app-enforced-multi-tenancy.md) for background on this
decision, and see
[`.claude/skills/tenant-safe-db/SKILL.md`](.claude/skills/tenant-safe-db/SKILL.md)
for implementation patterns.

Single-tenant setups initialize one default organization on startup and assign
all new users to it. Both modes use an identical database schema.

The query wrapper assumes that only this application server writes to Postgres.
If external tools query your database directly, such as BI tools, PostgREST, or
custom SQL agents, you must enable Postgres RLS on sensitive tables. The
application wrapper cannot protect database tables from external queries that
bypass it.

## Tests

Run the test suites with these commands:

```bash
pnpm lint                 # oxlint, anti-slop plus correctness
pnpm typecheck            # react-router typegen && tsc
pnpm test:unit            # node --test over tests/unit
pnpm test:integration     # node --test against a live server
```

The repository does not use a cloud CI pipeline. The `.githooks/pre-push` script
provides the only testing gate. It executes linting, type checks, unit tests,
content validation, and production build checks before pushing commits. You must
run `make hooks` or `pnpm install` in your local clone to install this hook.

The integration test suite executes CLI commands against an active application
server. Tests skip automatically when `TEST_API_KEY` is not present, allowing
safe runs without test credentials.

## Architecture decisions

The project records major architectural choices as Architecture Decision Records
(ADRs) in [`.adr/`](.adr/). Review the relevant record before editing an
architectural subsystem. Add a new ADR when making major architectural changes.

| # | Title |
|---|-------|
| [0001](.adr/0001-cli-wraps-the-api.md) | CLI wraps the API |
| [0002](.adr/0002-data-migrations.md) | Data migrations alongside schema migrations |
| [0003](.adr/0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS) |
| [0004](.adr/0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint |
| [0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint plus anti-slop is the lint gate |
| [0007](.adr/0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 |
| [0008](.adr/0008-e2ee-sync-copied-not-extracted.md) | The E2EE sync code is copied from openplate-sync, not shared |

## Contributing

We welcome issues and pull requests. Keep two details in mind before
contributing:

1. Read [`AGENTS.md`](AGENTS.md). This file outlines our coding standards for
   both human contributors and automated agents.
2. Run `make hooks` after cloning the repository. The pre-push hook acts as the
   sole test runner, and local clones do not include it by default.

All commit messages must follow the [Conventional
Commits](https://www.conventionalcommits.org) format.

## Licence

MIT. See [`LICENSE`](LICENSE).

The application **code** uses the MIT licence. The **dictionary data** in the
seed dump uses CC0 and CC BY 2.0 FR licences. The CC BY data requires
attribution to Tatoeba. See [the seed dump section](#licence-and-attribution)
for complete licensing terms.
