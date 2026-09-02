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
