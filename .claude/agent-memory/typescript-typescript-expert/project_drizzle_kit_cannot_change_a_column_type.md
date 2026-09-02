---
name: drizzle-kit-cannot-change-a-column-type
description: drizzle-kit emits a bare SET DATA TYPE for a column type change and orders ADD CONSTRAINT before ADD COLUMN; split the schema edit across generate runs instead of hand-editing SQL
metadata:
  type: project
---

`drizzle-kit generate` cannot express a column type change that Postgres has no
cast for, and it does not always order its own statements correctly. Two failures
seen back to back on `enrichment_votes.account_id` (uuid to integer):

1. It emits `ALTER COLUMN ... SET DATA TYPE integer` with no `USING`. Postgres
   has no uuid-to-integer cast, so the statement fails (`42804`) whatever the
   row count.
2. Asked to add the column and re-form a composite primary key in one migration,
   it emits `ADD CONSTRAINT ... PRIMARY KEY (enrichment_id, account_id)` BEFORE
   `ADD COLUMN account_id`, which fails with `42703`.

**Why:** the generator diffs snapshots and has no notion of statement dependency
or of a cast it cannot infer. Hand-editing the SQL is the usual advice, but this
repo blocks it: writing or editing `drizzle/migrations/*.sql` is forbidden by a
PreToolUse hook, and so is touching `meta/_journal.json`.

**How to apply:** drive the generator through INTERMEDIATE SCHEMA STATES and take
one migration per state. For the case above that was three generate runs: drop the
column (and remove it from the PK and index), add it back with the new type, then
restore the PK and index. Every file stays generated. Verify with a real
`drizzle:migrate` against the local database before reporting done, because
`drizzle:generate` succeeding proves nothing about whether the SQL runs.

Related: [[shared-local-postgres]] for the port the local database listens on.
