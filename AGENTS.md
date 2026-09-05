# Repository Guidelines

## Project Structure

- `app/` — routes, components, models, utilities, workflows
- `drizzle/` — database schema, migrations, data migrations
- `cli/` — Laravel-style management commands
- `server.ts` — Express + React Router v8 SSR entry (dev **and** production; see [ADR-0004](.adr/0004-custom-server-is-the-production-entry.md))
- `.claude/` — AI assistant rules, skills, and commands
- `tools/oxlint/anti-slop/` — vendored third-party lint plugin, MIT (do not edit; provenance in [tools/oxlint/README.md](tools/oxlint/README.md))
- `.githooks/` — pre-commit lint gate and pre-push test gate, installed by the `prepare` script

### Translations on demand (M193)

The code: `app/lib/translation/*` (payload, limits, enqueue, panel resolver),
`app/lib/llm/translation-schema.ts`, `app/prompts/translation/`,
`app/workflows/operations/translation/translate-headword.ts`,
`app/models/translation-runs.server.ts`, `drizzle/schema/translation-runs.ts`,
`app/components/translation-pane.tsx`, the routes
`api.translation.$headwordId.ts` and `api.translation.$headwordId.retry.ts`,
and `cli/commands/translation.ts`. Tests: `tests/unit/translation-*.test.ts`,
`tests/integration/translation-*.test.ts`, and
`tests/integration/anonymous-search-enqueues-no-translation.test.ts`.

Two rules: never pass `reasoningEffort` in a `registry.complete` call here,
because OpenRouter rejects `none` for gemini-3.8-flash, and the active model's
own configured setting already applies. And the pane has exactly five states,
`ready`, `translating`, `no-entry`, `budget`, `failed`, with no "no translation
yet" copy anywhere on the search surface.

### A phrase translates like a word (M195)

The code: `drizzle/schema/phrase-translations.ts`, `app/prompts/phrase/`,
`app/lib/llm/phrase-schema.ts`, `app/lib/translation/phrase-panel.server.ts`
and its enqueue and payload siblings, `app/models/phrase-runs.server.ts`,
`app/workflows/operations/translation/translate-phrase.ts`, the routes
`api.translation-phrase.ts` and its retry, and for the outside world
`app/lib/translation/translate-request.server.ts`,
`app/routes/api.v1.translate.ts`, `app/routes/api.v1.translation-votes.ts`
and `cli/commands/translate.ts`.

Three rules. **A phrase answer is never dictionary data**: it lives in
`phrase_translations` and the job must not touch `senses`, `headwords` or
`translations`, because a sentence is not a lexical edge and one row of running
text would poison every corpus query M193 built. **The word and the phrase
branch are decided by one call**, `normalizeQuery(q, from).isPhrase`, in the
loader AND in the API, so the screen and the CLI can never disagree about what a
phrase is. **A text over `PHRASE_MAX_CHARS` is refused, never truncated**:
truncating would translate a sentence the reader did not type and present it as
their answer. This reverses M193 decision 8, which said a phrase creates
nothing.

### Favourites, history and translation votes (M194)

The code: `app/lib/local-store/favorites.ts` and the `favorites` collection in
`schema.ts` (`SCHEMA_VERSION` 3, synced, in the blob),
`app/components/personal/favorite-toggle.tsx`,
`app/components/personal/saved-word-row.tsx`, `app/routes/favourites.tsx`,
`app/lib/local-store/history.ts`, `drizzle/schema/votes.ts`'s
`translationVotes`, `app/models/translation-votes.server.ts`,
`app/routes/api.translation-vote.ts`, `app/components/translation-votes.tsx`
and `app/lib/votes/optimistic.ts`.

Three rules. A favourite is NOT a list entry: one tap on an answer cannot ask a
reader to pick a sense first, so it is its own entity and lists stay curated
study material. `recordSearch` is an UPSERT on `(query, from, to)` and the row's
id survives, so a repeat search moves a row rather than adding one, and history
is still device-only with no sync stamp and nothing in the blob. A translation
vote is recorded and nothing else: no re-run, no hiding, no reordering, and the
operator's list on `/super/llm` is the only thing built on the scores.

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
| Push | full-tree oxlint → typecheck → unit tests → build | `.githooks/pre-push`, the repo's only test gate — there is no cloud CI |

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

Also not enabled: the `react-perf` plugin, which flags every inline callback
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

## Key Documentation

| Topic | Location |
|-------|----------|
| Design language and UI recipes | [DESIGN.md](DESIGN.md) |
| TypeScript | [.claude/typescript-rules.md](.claude/typescript-rules.md) |
| React | [.claude/react-rules.md](.claude/react-rules.md) |
| React Router v8 | [.claude/react-router-rules.md](.claude/react-router-rules.md), [skill](.claude/skills/react-router-framework-mode/SKILL.md) |
| Forms (Conform + Zod v4) | [.claude/conform-to-react.md](.claude/conform-to-react.md) |
| Workflows | [.claude/workflows.md](.claude/workflows.md) |
| CLI | [.claude/cli.md](.claude/cli.md) |
| Architecture Decisions | [.adr/README.md](.adr/README.md) |

**Read [DESIGN.md](DESIGN.md) before writing any UI.** It is the normative
source for surfaces, colour tokens, typography and layout, and the code cites it
by section and rule number, so a comment saying "DESIGN.md rule 3" is pointing
at a real, checkable statement. Two of its rules are enforced by
`tests/unit/design-rules.test.ts` rather than by review: no thick left border
accents, and no em dashes.

## Accounts

Two things about this app surprise people, so read them before touching anything
under `app/lib/sync/`, `app/routes/sign-*` or `app/routes/api.v1.auth.*`.

**1. Every search needs an account, and the account gate is keyed on the
request, not on the path.** Signup is open (M191, [ADR-0011](.adr/0011-plain-accounts-replace-the-encrypted-layer.md)): there is no
invite and no bootstrap token, so a route decision never needs to ask who
minted a way in. The contract, in full:

- `/` is public and must stay a `200` for a signed-out stranger, carrying a
  real worked example. It is the one screen that shows the product without
  costing a language-model call. Do not gate it.
- Everything past it needs an account: a typed search, entry pages, lists,
  history, review, attribution, settings, and `POST /api/v1/transcribe`. That
  last one was ungated on purpose before M184, and the reversal is deliberate.
- `/` and `/translate` are two route ids over ONE file, and the product's real
  URL is `/?q=<word>`. So the rule for that file lives at the top of its loader
  and reads the REQUEST: an empty `q` is the landing page, any other `q` needs
  an account. A path-keyed rule gated `/search` (this route's old name) and
  left `/?q=` wide open once already. Do not write another one.
- The screens with no public half are gated by nesting under
  `app/routes/_app.gated.tsx`, which carries `accountMiddleware`. That is the
  only app-screen gate. `authMiddleware` also demanded a linked `users` row,
  which almost no account had, and it is gone with that table (ADR-0010).
- The front door stays open. `/account`, `/sign-in`, `/sign-up` and `/offline`
  are never gated, because a gate in front of the sign-in page is a gate nobody
  can ever pass. `/healthcheck` and `/legal/*` stay public too, and
  `tests/integration/public-surface-*.test.ts` says so in executable form.
- The doors are `/sign-in` and `/sign-up`. They were `/sync/login` and
  `/sync/setup` until M189. The old paths still answer, with a permanent
  redirect that keeps the query string, from the era when a signup URL carried
  an invite token that had to survive the hop; nothing survives that hop
  today, since there is nothing left to carry.
- **The home page and `/account` carry both doors.** This reverses the older
  rule that neither screen may ask anybody to sign up. That rule belonged to an
  anonymous-by-default product, and M184 ended it: an account is now required
  for every search, so a home page with no way in is a wall, not restraint.
  `/sign-up` is the primary action and `/sign-in` the secondary one on both
  screens, and the shell header carries the same pair.
- **An account is an account, and sync is a consequence of holding one.** No
  user-facing screen presents sync as something to set up.
- **An account is an email address and a password** (M191). Signup is open, and
  the address has to be confirmed by a mailed link before the first sign-in. A
  forgotten password is replaced by a second mailed link, which also signs every
  other device out. Sign-up, sign-in and forgot-password all answer the same way
  for a known and an unknown address, so none of them is an enumeration oracle.
  `pnpm cli account grant-superadmin <email>` is the only out-of-band grant.
- The gate blocks the SCREEN, never the device's own store. Lists and history
  are still written locally and were never uploaded, and a redirect must not be
  the thing that deletes them.
- `app/lib/route-classification.ts` records how every file under `app/routes/`
  decides who may reach it. A new route file that nobody classified fails a
  unit test.

**2. The account is an address and a password (M191).** `users` holds the
address, a bcrypt hash at cost 10, the confirmation instant, the password-change
instant and the superadmin flag; `user_tokens` holds the digests of the two
mailed links, `verify` and `reset`. Nothing here is derived material a browser
computed, and the synced document in `sync_blobs.payload` is plain JSON the
operator can read.

Rules you cannot design around:

- **Nothing says which half of a credential was wrong.** `signIn` answers `null`
  for an unknown address, a wrong password and an unconfirmed address alike, and
  sign-up and forgot-password answer the same sentence whether or not the
  address is on file. Those decisions live in `app/services/auth.server.ts`, not
  in a screen, because the one caller that forgets is what builds the oracle.
- **A mailed link is consumed in one statement.** `UPDATE user_tokens SET
  used_at = now() WHERE token_hash = ... AND used_at IS NULL AND expires_at >
  now() RETURNING user_id`. A read-then-write pair lets two clicks on one reset
  link both be accepted.
- **`users.password_changed_at` is the session epoch.** The cookie carries
  `{ userId, issuedAt }` and nothing else; `authMiddleware` refuses a cookie
  older than that column. That is how a reset signs the other devices out with
  no session table. The tab that made the change is handed a fresh cookie by
  `auth.server.ts` and must set it.
- **The rate limiter reads `x-client-ip`, which `server.ts` writes** from
  `req.ip` after Express resolves `trust proxy`, deleting any incoming value
  first. Reading `x-forwarded-for` in a middleware would count a header the
  client can write. It is an in-memory map (`app/middleware/rate-limit.ts`),
  scoped to one process on purpose, and it resets on every deploy: a restart
  clears every counter, which is accepted because the limiter's job is to slow
  a script down, not to be exact.
- **The old encrypted layer is gone.** `app/lib/e2ee/`, its wire specification, the
  `accounts`, `account_tokens`, `sync_key_records` and `invites` tables, and the
  root secret they were peppered with, were all removed by M191. The copied sync
  ENGINE stays: `app/lib/sync/` still carries the Lamport merge and the
  compare-and-swap loop, under
  [ADR-0008](.adr/0008-e2ee-sync-copied-not-extracted.md), with the encrypt and
  decrypt steps replaced by JSON framing.
- **Mail is a hard dependency, not an enhancement.** `app/services/email.server.ts`
  sends over plain `fetch` against pigeon (`PIGEON_API_KEY`, `PIGEON_BASE_URL`),
  from `EMAIL_FROM`. Production refuses to boot without both pigeon variables set
  rather than fail a signup silently; every other environment falls back to a
  console transport that prints the verification and reset links in full, which
  is the only way to reach them in local dev with no mail service configured.

**Tests for this area moved.** `tests/unit/e2ee/` is gone with the library it
tested. In its place: `tests/unit/auth/` covers the password rule and the
token digest and expiry logic, and `tests/unit/email/` covers the mail
templates and the pigeon transport, including its console fallback.

`users` is the only identity in this app. The organization tables are gone
(M189, [ADR-0010](.adr/0010-drop-the-inherited-tenancy.md)): they held zero rows
and nothing read them. `apiKeys` stands alone, carrying its own `isSuperadmin`
flag rather than joining through a user row to an organization, and
screen-level superadmin is `users.is_superadmin`.

`/super/*` holds two screens and nothing else: `llm`, which edits the model
selection enrichment reads out of `app_settings`, and `whoami-ip`, which echoes
the IP the server resolved so a `TRUST_PROXY` hop count can be checked against a
live proxy. A bare `/super` redirects to `/super/llm`. On the hosted instance
`/super` is fenced twice: Bay's `vpn_routes` restricts it to the operator's
tailnet, and the superadmin session check runs as an independent second layer.

### Account and mail environment variables

| Variable | Required | What it does |
|----------|----------|---------------|
| `SESSION_SECRET` | Production | Signs and encrypts the session cookie. Rotating it signs everybody out. |
| `PIGEON_API_KEY` | Production | The tenant key that authenticates mail sends to pigeon. |
| `PIGEON_BASE_URL` | Production | The pigeon service address, e.g. `http://100.64.0.1:3601`. |
| `EMAIL_FROM` | No, defaults to `no-reply@translate.altan.fyi` | The sender address on outgoing mail. |

Production refuses to start if `PIGEON_API_KEY` or `PIGEON_BASE_URL` is unset.
The root peppering secret and the one-shot signup token from the account model
M191 removed are both gone, and no replacement was needed: this table is now
the complete list.

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
| [0003](.adr/0003-app-enforced-multi-tenancy.md) | App-enforced multi-tenancy (no RLS) | Superseded by 0010 |
| [0004](.adr/0004-custom-server-is-the-production-entry.md) | The custom `server.ts` is the production entrypoint | Accepted |
| [0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md) | oxlint + anti-slop is the lint gate | Accepted |
| [0007](.adr/0007-one-linter-and-typescript-7.md) | One linter (oxlint), and TypeScript 7 | Accepted |
| [0008](.adr/0008-e2ee-sync-copied-not-extracted.md) | The E2EE sync code is copied from openplate-sync, not shared | Superseded by 0011 |
| [0009](.adr/0009-invite-only-accounts.md) | Invite-only accounts, bootstrapped by a one-shot token | Superseded by 0011 |
| [0010](.adr/0010-drop-the-inherited-tenancy.md) | Drop the inherited tenancy, org and CMS surfaces | Accepted |
| [0011](.adr/0011-plain-accounts-replace-the-encrypted-layer.md) | Plain accounts replace the encrypted layer | Accepted |

## Coding Style Summary

- **TypeScript**: Strict types, no `any`, use Zod inference
- **Files**: `kebab-case.ts/tsx`; routes use `_layout.tsx` patterns
- **React**: Avoid `useEffect` for derived state; prefer early returns over nested ternaries
- **Drizzle**: Use `Select*` types in UI, `Insert*` for mutations

## API-First — CLI wraps the API

**Rule:** new functionality lands in the HTTP API first; the CLI is a thin client over that API. Never add a CLI subcommand that talks to the DB or business logic directly when an API call could do the same work.

**Why:**
- Single code path for web UI, CLI, third-party clients, and LLM agents — no drift
- HTTP layer carries auth and audit on every operation
- Prod CLI calls don't require DB credentials on the operator's machine
- Remote agents can act on prod via `--remote=<url>` + scoped API keys

**Bootstrap-only exceptions** (direct-DB allowed because they precede the auth surface itself):
- `api-key create` — bootstrap the first key for a fresh environment
- `db check`, `db migrate`, `db reset` — DB-level health and lifecycle, run before the API is up

These are enumerated in [ADR-0001](.adr/0001-cli-wraps-the-api.md). Don't add to the list without an ADR amendment.

See `.adr/0001-cli-wraps-the-api.md` for the full rationale. The four-layer pattern in the next section is the canonical recipe for adding any non-bootstrap feature.

### Adding a new endpoint (the four-layer pattern)

Every non-bootstrap feature touches four files. Doing all four keeps `--remote` HTTP mode, direct-DB CLI mode, and the web/agent surface in sync.

**Layer 1 — Model** (`app/models/<resource>.server.ts`)

The business-logic primitive. There is no tenancy and no query wrapper: this app
has one instance and one dictionary cache, so a model reads and writes its table
through `db` directly (ADR-0010). List functions return `{ rows, total }` with a
real `COUNT(*)` run in parallel.

```typescript
export async function listFoos(
  pagination: PaginationParams = { limit: 20, offset: 0 },
): Promise<{ rows: SelectFoo[]; total: number }> {
  const [rows, totalRow] = await Promise.all([
    db.select().from(foos).orderBy(desc(foos.createdAt))
      .limit(pagination.limit).offset(pagination.offset),
    db.select({ value: count() }).from(foos).then((r) => r[0]),
  ]);
  return { rows, total: Number(totalRow?.value ?? 0) };
}
```

**Layer 2 — HTTP route** (`app/routes/api.v1.<resource>.ts`, registered in `app/routes.ts`)

Use the shared auth helpers from `app/lib/api-auth.server.ts`:
- `requireApiKey(request)` — returns the key after the revoked-key check.
- `requireSuperadminApiKey(request)` — same, but refuses a key whose `isSuperadmin` is false. Use it for anything operational.
- `jsonError(status, message)` — always `throw jsonError(...)`. Returns the standard `{ error, code }` JSON envelope.

List endpoints use `parsePaginationParams(url.searchParams)` + `paginatedJson({data, total, limit, offset})` from `app/lib/pagination.server.ts` for a uniform envelope and clamped limits (default 20, max 100).

```typescript
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url);
  await requireApiKey(request);

  const pagination = parsePaginationParams(url.searchParams);
  const { rows, total } = await listFoos(pagination);
  return paginatedJson({ data: rows, total, ...pagination });
}
```

**Layer 3 — DirectTransport registration** (`cli/lib/direct-transport-handlers.ts`)

Register a responder with the same path/method/shape as the HTTP route. This is what runs when the CLI is invoked without `--remote` (the default for local dev). All registrations live in one file — do **not** scatter `direct.register(...)` calls across command files.

```typescript
direct.register('GET', '/api/v1/foos', async ({ query }) => {
  const pagination = parsePaginationParams(query);
  const { rows, total } = await listFoos(pagination);
  return { data: rows, total, ...pagination };
});
```

**Layer 4 — CLI command** (`cli/commands/<resource>.ts`)

Flat file under `cli/commands/`. Only `data-migration/` is nested today; everything else is one file per resource group. The command imports the `transport` live-binding singleton from `cli/lib/transport.ts` and calls `transport.get(path, params?)` — never `instanceof` the transport, use `isHttpTransport(t)` from `transport.ts` if you must branch.

```typescript
import { transport } from '../lib/transport';

async function listFoosCmd(options: { format: OutputFormat; limit: string; offset: string }) {
  const response = await transport.get('/api/v1/foos', {
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

If a table holds a credential artifact (hash, token, encrypted blob), never let it cross the route boundary. Pattern from `app/models/api-keys.server.ts`:

1. Export a `SelectFooPublic = Omit<SelectFoo, 'secretField'>` type from the model.
2. Define a `fooPublicColumns` Drizzle projection that lists every column except the secret.
3. Use `db.select(fooPublicColumns).from(foos)…` for reads.
4. For `UPDATE … RETURNING`, follow the update with a `SELECT fooPublicColumns` to fetch the post-update row without the secret.
5. Every public-facing function returns `SelectFooPublic` (or `{ rows: SelectFooPublic[], total }` for lists). The secret column is read only inside the model, only for WHERE-clause matching during auth.

The downstream types (`ApiKeyAuth.apiKey`, formatters, CLI columns) all reference the public type — there's no path for the secret to leak via inference.


## Calling the CLI against production

With all commands migrated to HTTP, an LLM agent or human operator can act on production data using only an API key — no database credentials required.

### Creating the first API key

The first key must be created via direct-DB access (bootstrap exception per ADR-0001):

```bash
pnpm cli api-key create --name="agent-key"
# Outputs: sk_...  (copy this value)
```

Add `--superadmin` for a key that may reach the DB admin endpoints.

### Using the key

```bash
export TRANSLATE_API_KEY=sk_<your-key>

# Against a specific server
pnpm cli --remote=http://localhost:3456 api-key list
pnpm cli --remote=https://app.example.com db check
```

### `--prod` shorthand

Set `TRANSLATE_PROD_URL` in your environment and use `--prod` instead of `--remote`:

```bash
export TRANSLATE_PROD_URL=https://app.example.com
pnpm cli --prod api-key list
```

### Key scopes

There are two, and no organization behind either (ADR-0010):

| Key type | What it can access |
|----------|-------------------|
| **Ordinary** | The api-key endpoints. |
| **Superadmin** (`isSuperadmin` on the key itself) | The above, plus `admin/db/*`, and revoking any key. |

### Example commands

```bash
# API keys
pnpm cli --prod api-key list

# Database (superadmin key required)
pnpm cli --prod db check
pnpm cli --prod db tables
```

### Safety note

CLI commands sent via `--remote` go through the app's HTTP auth layer — auth is enforced and all operations are auditable. No raw database access is required on the operator's machine.

## Data Migrations

Schema migrations (`drizzle/migrations/`) change the shape of the DB. **Data migrations** change the contents — backfills, enrichments, one-time fix-ups, repopulating denormalized columns. They live alongside schema migrations and run automatically on deploy.

**Key properties:**
- Tracked in a `data_migrations` table (name + applied_at) so each runs at most once per environment
- Discovered from `drizzle/data-migrations/<YYYY-MM-DD>-<slug>.ts` at startup
- Each migration is an async function that receives a DB connection and runs inside a transaction
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

## Commits

Use Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`

See: [.claude/commands/commit.md](.claude/commands/commit.md)

## Claude Code Integration

```
.claude/
├── commands/       # /commit, /sync-cli
├── skills/         # cli-sync, form-persistence, react-router-framework-mode
├── hooks/          # Post-edit validations (see below)
└── *.md            # Coding standards
```

`PostToolUse` hooks run on every `Write`/`Edit`:

| Hook | What it does |
|------|--------------|
| `lint-edited-file.sh` | Runs oxlint on the edited file. A finding **blocks** with the diagnostic, so slop is corrected in the same turn rather than at commit time. |
| `on-schema-change.sh` | Reminds you to generate a migration after a `drizzle/schema.ts` edit. |

If a lint hook blocks you: fix the code. Do not downgrade the rule, and do not
add a suppression comment — see [ADR-0005](.adr/0005-oxlint-and-anti-slop-are-the-lint-gate.md).
