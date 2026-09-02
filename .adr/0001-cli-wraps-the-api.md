# 0001 — CLI wraps the API

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** Altan

## Context

The CLI (`pnpm cli ...`) historically imported Drizzle models directly and spoke to Postgres. This has several problems:

- Prod operations require DB credentials on the operator's machine.
- CLI bypasses HTTP auth, tenant scoping, and audit trail — separate code path from what web/API clients use.
- LLM agents can't act on prod data without raw DB access, which is unacceptable.
- Two code paths drift over time: a feature added to the API may quietly diverge from its CLI counterpart.

We also want a single way to extend the system: when a new capability is added, it should be reachable from web, CLI, third-party scripts, and agents without writing the feature twice.

## Decision

**All new functionality is added to the HTTP API first. The CLI is a thin wrapper that authenticates with an API key and calls those endpoints.**

Concretely:

- New features land as REST endpoints under `/api/v1/...` (org-scoped) or `/api/v1/admin/...` (superadmin).
- CLI commands in `cli/commands/<group>/` only build the request, call `createTransport().fetch(...)`, and format the response.
- Auth is via `Authorization: Bearer <api-key>`; the CLI reads it from `TRANSLATE_API_KEY` or `--token`.
- A `--remote=<url>` flag (with `--prod` shorthand) chooses the target; default is local dev.

**Bootstrap-only exceptions** — these CLI commands legitimately need direct-DB access because they create or verify the things auth depends on:

- `api-key create` — bootstrap the first API key for a fresh environment.
- `user create` / `org create` — bootstrap the first superadmin and org.
- `db check`, `db migrate`, `db reset` — DB-level health/lifecycle, run before the API is up.

Everything else goes through HTTP. Adding to this list requires a new ADR amendment.

## Amendment, 2026-09-02: the open-data importers, and their verification counterpart

`pnpm cli import wikidata-lexemes`, `import panlex` and `import tatoeba` talk to
Postgres directly. They are added to the exception list above.

The reason is not convenience. It is that the operation cannot be expressed as an
HTTP call at all:

- The dumps are 450 MB (Wikidata lexemes, bzip2) and 300 MB (Tatoeba sentences,
  bzip2), decompressing to several gigabytes. Sending that through a REST endpoint
  means either uploading a multi-gigabyte body or asking the server to fetch and
  hold it, and both are worse than a local file path.
- The write is millions of rows in bulk-upserted chunks inside one long-running
  process. An HTTP request has a timeout; this run does not fit inside one.
- It is an operator action against a dump the operator downloaded by hand. There
  is no tenant to scope: the dictionary tables are global and carry no
  `organizationId`, so the tenancy enforcement that ADR-0001 exists to centralise
  has nothing to enforce here.
- Nothing about the import is per-user or auditable in the sense the ADR means. It
  loads public, CC0 and CC BY reference data.

What stays true: reading the dictionary is NOT an exception. Every query surface
that serves this data to a user goes through the ordinary API path, with the
licence filter in SQL (`app/lib/dictionary/queries.server.ts`).

The importers are also deliberately NOT data migrations (ADR-0002). A data
migration runs once, automatically, at container start. An import must be
re-runnable on demand by an operator, must never run at boot, and takes flags
(`--file`, `--languages`, `--max-rows`, `--dry-run`) that a boot-time runner has
no way to supply.

`pnpm cli dictionary stats` is on the list for the same reason, as the import's
verification counterpart. An import is an offline operator action against a
local dump, run with no server up. A check that could only be reached through
the HTTP API would be unable to verify the thing that just happened. It is
read-only, it reads the same global tables, and it reports aggregate counts
only.

That is the whole exception, and it does not widen. Reading dictionary rows to
show a user goes through the ordinary API path, with the licence filter in SQL.

## Alternatives Considered

- **Keep direct-DB CLI, add HTTP for web only.** Maintains two code paths permanently; agents still locked out of prod. Rejected.
- **GraphQL or RPC layer instead of REST.** More tooling to learn, no clear win for our scope. REST + the existing route conventions are sufficient.
- **Service layer extracted from routes, CLI imports the service.** Still requires CLI to load the full server stack and DB creds locally; doesn't get us remote-agent capability. Rejected.

## Consequences

**Good:**
- One auth + tenancy + audit path for everyone.
- LLM agents can be granted scoped API keys and operate on prod safely.
- New features automatically work for web, CLI, and third-party clients.
- Operators don't need DB creds on their laptops.

**Bad / cost:**
- Migrating existing CLI commands is non-trivial — see [M1](../.tracker/M1-cli-http-api-wrapper/00-README.md) for the plan.
- Bootstrap commands remain direct-DB; we have to be disciplined about keeping that list small.
- CLI gains a network dependency for almost everything — local dev needs the server running.

## References

- Milestone: [.tracker/M1-cli-http-api-wrapper](../.tracker/M1-cli-http-api-wrapper/00-README.md)
- `cli/lib/transport.ts` (to be created in M1 spec 01)
- `app/lib/api-auth.server.ts` (to be created in M1 spec 01)
