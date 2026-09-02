# 0002 — Data migrations alongside schema migrations

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** Altan

## Context

Schema migrations (`drizzle/migrations/`) handle DDL — creating tables, adding columns, dropping indexes. They don't handle the messy reality of changing data: backfilling a new NOT NULL column, normalizing values in bulk, repopulating a denormalized cache after a refactor, re-enriching items after we change how an enrichment works.

Today, that work happens as ad-hoc psql scripts or one-shot CLI invocations against prod. Problems:

- Nothing tracks whether a given data fix has run. People re-run it, or skip it on a new environment.
- It's not part of the deploy pipeline — someone has to remember to run it manually.
- The change isn't reviewable; it lives in someone's shell history.
- Bringing up a fresh env (staging, a new region) means re-discovering all the implicit fix-ups.

## Decision

Introduce **data migrations** as a first-class concept, modeled on schema migrations but separate:

- **Table:** `data_migrations` — primary key `name` (the filename), `applied_at` timestamp. Tracked per environment.
- **Files:** `drizzle/data-migrations/<YYYY-MM-DD>-<kebab-slug>.ts`, each exporting `default async function (db) { ... }`.
- **Runner:** `pnpm cli data-migration run` — discovers files, skips already-applied names, runs each remaining one inside a transaction, records the name on success.
- **Deploy hook:** runs after schema migrations, before traffic is served. Same Docker entrypoint that runs `drizzle migrate` runs `data-migration run` immediately after.
- **Idempotency expectation:** authors should write migrations to be safe-to-re-run anyway (the tracking table is a belt-and-suspenders mechanism, not the only line of defense).
- **No down migrations.** If a data migration was wrong, write a new one that fixes it forward.

## Alternatives Considered

- **Bake data fix-ups into schema migration files (Drizzle `sql\`...\``).** Mixes concerns; Drizzle migrations should remain pure DDL so we can reason about them and roll them out separately. Bulk data updates also routinely need to call application code (enrichment, hashing), which raw SQL migrations can't do.
- **Use Drizzle Kit's migration mechanism for data too.** Same problem — it's a SQL-string runner, not a TS function runner.
- **One-off scripts in `scripts/` invoked manually.** That's where we are today; doesn't solve "did this run on staging yet?"
- **Job/queue-based runner.** Overkill — these run at deploy boundaries, not continuously.

## Consequences

**Good:**
- One reliable place to express bulk data changes; reviewable in PRs.
- Deploys auto-apply; new environments come up correctly.
- Migrations can use app code (models, validators, enrichment) because they run as TS in the app process.
- Per-env tracking makes it obvious which fix-ups have shipped where.

**Bad / cost:**
- New mechanism for contributors to learn.
- Migrations that touch large tables can extend deploy time; we'll need a "long-running migration" pattern eventually (background-process variant), but that's deferred.
- Tracking happens per-env, so if you restore a DB dump from prod to staging the `data_migrations` rows come along — that's the correct behavior, but worth knowing.

## References

- Spec: [M1 — Data migrations subsystem](../.tracker/M1-cli-http-api-wrapper/08-data-migrations-subsystem.md) *(to be created)*
- `drizzle/migrations/` — existing schema-migration convention
- `cli/` — where the runner command will live
