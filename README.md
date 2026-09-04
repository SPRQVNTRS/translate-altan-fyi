# translate.altan.fyi

A vocabulary and translation web app. You type a word or a phrase. The app
returns a translation, a plain explanation, and example sentences. You can
collect terms into learning lists. The front page is public, and it shows a
real worked example from the dictionary. Everything past it needs an account: a
typed search, entry pages, lists, history, review, and voice input. Creating an
account needs an invite, because every explanation the app writes costs the
operator a language-model call. The hosted instance at
[translate.altan.fyi](https://translate.altan.fyi) hands out those invites one
at a time. Your lists and history live on your own device, and what you sync
between your devices is encrypted end to end, so the server cannot read it.
This repository contains the entire codebase under the MIT licence. You can
host it yourself, and your own instance admits its first account with a
bootstrap token that you set. See [Self-hosting](#self-hosting) below, and
[ADR-0009](.adr/0009-invite-only-accounts.md) for why the gate exists.

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
# Edit .env. At minimum set the DB_* variables. SESSION_SECRET is required in
# production and has a development default otherwise.
#
# Mail is optional in development: with no PIGEON_API_KEY the confirmation and
# reset mails are logged to the console instead of being sent.

pnpm drizzle:migrate   # create the schema
pnpm dev               # dev server and worker together
```

The app runs at `http://localhost:${PORT}`, which defaults to `3000`.

### Your first account

Signup is open. Create an account at `/sign-up`, or from the "Create account"
button on the front page, then click the link in the confirmation mail. In
development with no mail configured, that link is printed to the console the
dev server is running in.

Then grant yourself the two operator screens under `/super/`, which are the
language-model configuration and an IP echo for checking `TRUST_PROXY`:

```bash
pnpm cli account grant-superadmin <your-email>
pnpm cli account list
```

Both commands read the database directly, so run them where `.env` is readable.
They do not need a superadmin account, which is what makes the first grant
possible at all.

A forgotten password is recoverable: `/forgot-password` mails a link that sets a
new one, and doing so signs every other device out.

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

- `SESSION_SECRET` encrypts and signs the user session cookie. Rotating it signs
  everybody out; nothing else depends on it.
- `PIGEON_API_KEY` and `PIGEON_BASE_URL` are what let the confirmation and reset
  mails leave the instance. Production refuses to send without them rather than
  dropping a link silently.

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

## Accounts and the synced personal document

Signup is open. The front page is public and carries a worked example.
Everything past it needs an account: a typed search, entry pages, lists,
history, review, and voice input. A signed-out visitor who searches is sent to
`/sign-in`, and the front page, `/account` and the app header all carry a
"Create account" button beside a "Sign in" link.

An account is an email address and a password. The address has to be confirmed
by a mailed link before the first sign-in, a forgotten password is replaced by a
second mailed link, and replacing it signs every other device out. Sign-up,
sign-in and forgot-password answer the same way for an address that is on file
and one that is not, so none of them can be used to find out who has an account
here.

An account is also what carries state between a person's devices. Word lists,
notes, review state and history are written on the device that made them. All of
them except the search history are pushed to the server as one JSON document,
under a compare-and-swap version that stops two devices overwriting each other.

**The operator can read that document.** It is stored as ordinary JSON in
`sync_blobs.payload`. The search history is the one collection that never
leaves the device
([`app/lib/local-store/BLOB-CONTENTS.md`](app/lib/local-store/BLOB-CONTENTS.md)
says what travels and what does not).

Until M191 the document was encrypted with a key the server could not derive,
and accounts were opaque handles with a recovery code instead of an address.
That bar cost the only thing it was protecting: a reader had no way to be told
who they were signed in as and no way to reset a password. The claim in this
README and on the privacy page is what is true now, not what used to be.

## CLI

The CLI communicates with the same HTTP REST API that powers the web interface.
Provide a `TRANSLATE_API_KEY` to run commands through standard HTTP
authentication and audit logging.

```bash
pnpm cli api-key list
pnpm cli --remote=http://localhost:3000 db check
TRANSLATE_PROD_URL=https://app.example.com pnpm cli --prod db tables
```

See [`.claude/cli.md`](.claude/cli.md) for full command documentation, and see
[`AGENTS.md`](AGENTS.md) for API conventions.

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
and production build checks before pushing commits. You must
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
| [0003](.adr/0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS), superseded by 0010 |
| [0004](.adr/0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint |
| [0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint plus anti-slop is the lint gate |
| [0007](.adr/0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 |
| [0008](.adr/0008-e2ee-sync-copied-not-extracted.md) | The E2EE sync code is copied from openplate-sync, not shared |
| [0009](.adr/0009-invite-only-accounts.md) | Invite-only accounts, bootstrapped by a one-shot token |
| [0010](.adr/0010-drop-the-inherited-tenancy.md) | Drop the inherited tenancy, org and CMS surfaces |

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
