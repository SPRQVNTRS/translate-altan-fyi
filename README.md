# translate.altan.fyi

A vocabulary and translation web app. You type a word or a phrase, and you get a
translation, a plain explanation and example sentences, and you can collect what
you want to learn into lists. It works with no account: search, lists and history
live on your device. An account exists for one reason only, syncing to a second
device, and when you make one your personal data is end to end encrypted. The
hosted instance is [translate.altan.fyi](https://translate.altan.fyi). This
repository is the whole thing, under the MIT licence, and it is meant to be
self-hosted.

## Architecture in five lines

1. One service. TypeScript, Vite, React Router v8 and Express in a single
   process, with a second process for background work.
2. Postgres is the only datastore. Drizzle owns the schema and the migrations.
3. pg-boss carries the background jobs, and `worker.ts` is what runs them.
4. The encrypted personal zone is copied from `openplate-sync` rather than shared
   as a package, for the reasons in [ADR-0008](.adr/0008-e2ee-sync-copied-not-extracted.md).
5. The dictionary is built from open data: Wikidata lexicographical data (CC0)
   and Tatoeba sentences (CC0 and CC BY 2.0 FR). Attribution travels with the
   data in the `sources` table.

## Self-hosting

### What you need

- Node.js 22 or newer. `.nvmrc` pins 24 for development, and the production
  image (`Dockerfile.pnpm`) builds on 22.
- pnpm 11. The repository declares it in `packageManager`, so
  [corepack](https://nodejs.org/api/corepack.html) will pick the right one.
- PostgreSQL 15 or newer, with the `pg_trgm` extension available. Search uses
  trigram similarity for the "did you mean" branch.

There is **no private registry token**. All four `@sprqvntrs/*` dependencies are
published to npmjs.com under MIT, and `.npmrc` pins the scope to
`https://registry.npmjs.org/` so the install works even on a machine whose
`~/.npmrc` routes that scope somewhere else.

Those packages ship raw TypeScript, so `vite.config.ts` lists them in
`ssr.noExternal`. Vite has to compile them rather than hand them to Node.

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

The app is served at `http://localhost:${PORT}`, which is `3000` by default.

`pnpm dev` runs two processes: `dev:server` (Express with React Router SSR) and
`dev:worker` (the pg-boss worker). Each can run alone with `pnpm run dev:server`
or `pnpm run dev:worker`.

### Migrations and the worker in a deployment

`scripts/start.sh` is the container entrypoint, and it does three things in
order:

1. `pnpm drizzle:migrate` applies pending schema migrations.
2. `pnpm cli data-migration run` applies pending data migrations, which are
   TypeScript one-shots tracked in a `data_migrations` table. See
   [ADR-0002](.adr/0002-data-migrations.md).
3. It starts the web process and the **worker** process side by side and
   supervises both. If either one dies, the container exits so it restarts as a
   unit.

The worker is not optional. Word enrichment is a pg-boss job, and a queued job
that nothing dequeues is a page that never finishes loading.

Build and run the image with:

```bash
docker build -f Dockerfile.pnpm -t translate-altan-fyi .
docker run --env-file .env -p 3000:3000 translate-altan-fyi
```

Without Docker, `pnpm build` then `pnpm start` runs the web process, and
`pnpm worker` runs the worker. You still have to run `pnpm drizzle:migrate`
yourself before the first start.

## The seed dump

Building the dictionary from scratch means downloading multi-GB Wikidata and
Tatoeba dumps and running the importers for hours. You do not have to. A seed
dump of the shared dictionary zone is published as a release asset:

- **Download:** [`dictionary-seed-2026-09-02.dump`](https://github.com/SPRQVNTRS/translate-altan-fyi/releases/download/seed-2026-09-02/dictionary-seed-2026-09-02.dump)
  (45 MB, custom pg_dump format), with an
  [md5 checksum](https://github.com/SPRQVNTRS/translate-altan-fyi/releases/download/seed-2026-09-02/dictionary-seed-2026-09-02.dump.md5)
  next to it.
- **Generated:** 2026-09-02.
- **Contents:** 383,185 headwords, 102,335 senses, 107,085 sense versions,
  1,862 translations, 99,744 example sentences, 829,264 example-to-headword
  links, and the 4 `sources` rows.

### Licence and attribution

The dump carries data from three sources, and its `sources` table is what a
running instance renders as attribution:

| Source | Licence | What it is |
|--------|---------|------------|
| Wikidata lexicographical data | CC0 1.0 | headwords, senses, glosses |
| Tatoeba (CC0 sentences) | CC0 1.0 | example sentences |
| Tatoeba | CC BY 2.0 FR | example sentences |

**The CC BY 2.0 FR rows carry an attribution obligation.** If you serve this
data you must credit Tatoeba and link back to the sentence. The app does this
already, using the `attribution` column. Do not delete the `sources` rows and do
not strip the attribution from the UI, or your instance is out of compliance.

### Restore

The dump carries rows only, never schema. Run the migrations first, then:

```bash
curl -LO https://github.com/SPRQVNTRS/translate-altan-fyi/releases/download/seed-2026-09-02/dictionary-seed-2026-09-02.dump
scripts/dictionary-restore.sh --truncate-first dictionary-seed-2026-09-02.dump
```

The script reads the same `DB_*` variables as the app and passes
`--single-transaction`, which matters more than it looks: without it,
`pg_restore --data-only` exits 0 after every single row failed to load.
`--truncate-first` empties the nine dictionary tables before the load, which you
need because one migration seeds a `sources` row that the dump also carries.
The restore needs superuser rights, because `--disable-triggers` does.

Expect a few minutes. Then count the rows, do not trust the exit code:

```bash
psql -d "$DB_NAME" -c 'SELECT count(*) FROM headwords;'
```

`scripts/verify-seed-restore.sh` does all of that against a throwaway database
and prints the counts, and `scripts/make-seed-dump.sh` is what regenerates the
dump from an instance of your own.

## Language model provider

The generated explanation and the generated example sentence come from a
language model, reached through [OpenRouter](https://openrouter.ai). This is
**optional**. Set `OPENROUTER_API_KEY` in `.env` to turn it on. With no key the
app still works and serves dictionary results only: translations, senses and the
imported Tatoeba examples. Nothing crashes and no page breaks, you simply get
less on an entry.

Generated text is labelled as such in the UI and recorded against the
`Generated explanations` source, so a reader can tell it from imported data.

Spending is capped. A daily budget with a warning threshold lives in
`app_settings`, and `ALERT_WEBHOOK_URL` gets a POST when it is crossed. With no
webhook the alert is written to the log instead, which is a complete alert for a
self-hosted install.

## Configuration

`.env.example` lists every variable the app reads, with a comment on each and
placeholder values only. Environment access is centralised in `app/config/`, so
that directory and `.env.example` are the two places to look.

```typescript
import { CONFIG } from '#config';

const port = CONFIG.server.port;
const dbUrl = CONFIG.database.url;
```

Two secrets deserve a second look before you deploy:

- `SESSION_SECRET` signs the session cookie.
- `SERVER_SECRET` is the root of the encrypted personal zone. It cannot decrypt
  anything, but rotating it invalidates every stored verifier, which means every
  account has to recover. `.env.example` explains exactly what it does.

### Database connection pooling

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MAX` | `10` | Maximum number of connections |
| `DB_POOL_MIN` | `2` | Minimum connections to maintain |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle connection close timeout |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Connection acquisition timeout |

In production, pool statistics are logged every 60 seconds, and a warning fires
when `waitingCount > 5`.

### Schema changes

`drizzle/schema.ts` is the source of truth. Use `pnpm drizzle:push` while a
change is in flux locally, and `pnpm drizzle:generate` plus `pnpm drizzle:migrate`
once you want it recorded. A deploy only ever runs `drizzle:migrate`.

The `drizzle:*` scripts invoke `drizzle-kit` through `tsx` rather than directly,
because Node does not strip TypeScript inside `node_modules` and the schema
imports from TS-only packages.

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

## CLI

The CLI is a thin client over the same REST API the web UI uses. Set
`TRANSLATE_API_KEY`, and every command goes through HTTP auth, tenancy
enforcement and audit.

```bash
pnpm cli api-key list --org=default
pnpm cli --remote=http://localhost:3000 workflow list --format=json
TRANSLATE_PROD_URL=https://app.example.com pnpm cli --prod org list
```

See [`.claude/cli.md`](.claude/cli.md) for the full command surface, and
[`AGENTS.md`](AGENTS.md) for the API-first pattern.

## Multi-tenancy

The app supports multi-tenant deployments with organization-based isolation
enforced in **application code** via a typed query wrapper (`tenantDb(ctx)` from
`#drizzle/tenant-db`). Postgres RLS is **not** used. See
[ADR-0003](.adr/0003-app-enforced-multi-tenancy.md) for the rationale, and
[`.claude/skills/tenant-safe-db/SKILL.md`](.claude/skills/tenant-safe-db/SKILL.md)
for the patterns.

A single-tenant deployment creates one organization at startup and assigns new
users to it. The schema does not change between the two modes.

The wrapper assumes this app's server is the only writer to Postgres. If you
expose the database directly, to a BI tool with shared credentials or to
PostgREST or to an agent writing arbitrary SQL, put RLS back for the exposed
tables. The wrapper does not protect against actors that bypass it.

## Tests

```bash
pnpm lint                 # oxlint, anti-slop plus correctness
pnpm typecheck            # react-router typegen && tsc
pnpm test:unit            # node --test over tests/unit
pnpm test:integration     # node --test against a live server
```

There is no cloud CI. `.githooks/pre-push` is the whole gate, and it runs lint,
typecheck, unit tests, content validation and a production build before every
push. It only exists in a clone where `make hooks` or `pnpm install` has run.

The integration suite spawns CLI subcommands against a running server. Every
case skips itself when `TEST_API_KEY` is unset, so the suite is safe to run with
no seeded credentials.

## Architecture decisions

Significant choices are recorded as ADRs in [`.adr/`](.adr/). Read the relevant
one before changing that area, and write a new one when you make a decision of
similar weight.

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

Issues and pull requests are welcome. Two things to know before you open one:

1. Read [`AGENTS.md`](AGENTS.md). It is the coding standard, and it is written
   for humans as much as for coding agents.
2. Run `make hooks` after cloning. The pre-push gate is the only test gate there
   is, and a fresh clone does not have it.

Commits use [Conventional Commits](https://www.conventionalcommits.org).

## Licence

MIT. See [`LICENSE`](LICENSE).

The **code** is MIT. The **dictionary data** in the seed dump is not: it is CC0
and CC BY 2.0 FR, and the CC BY rows oblige you to attribute Tatoeba. See
[the seed dump section](#licence-and-attribution) above.
