---
name: bootstrap-zero-account-check-needs-an-advisory-lock
description: SELECT count(*) FOR UPDATE cannot lock an empty table, so the zero-account bootstrap check uses pg_advisory_xact_lock; a test that needs an empty table clones it into a run-scoped schema
metadata:
  type: project
---

The `ACCOUNT_BOOTSTRAP_TOKEN` branch is admitted only while `accounts` is empty,
and that count is taken behind
`pg_advisory_xact_lock(hashtext('translate-altan-fyi:account-bootstrap'))`
inside the insert's own transaction.

**Why:** `SELECT count(*) FROM accounts FOR UPDATE` locks the rows it RETURNED,
and on an empty table it returned none, so two concurrent bootstrap signups both
observe zero and both insert. Postgres has no predicate lock outside
SERIALIZABLE, and raising the isolation level would buy the same guarantee at the
price of retryable serialisation failures. Verified by falsification: removing
the lock makes
`tests/integration/bootstrap-token-single-first-account.test.ts` report
"admitted 2 concurrent signups".

**How to apply:**
- Any "this may happen only while the table is empty" rule needs the advisory
  lock, not a row lock. `hashtext` being an internal function is fine: the key
  is never persisted or compared across releases, it only has to agree among
  sessions on the same server at the same moment.
- The invite branch takes NO advisory lock and must not. It is serialised by the
  row lock its single conditional `UPDATE ... WHERE redeemed_at IS NULL` already
  holds; a `SELECT` then `UPDATE` there fails the same falsification.
- **An integration test that needs an empty shared table must build its own
  schema.** The dev database is shared and truncating it destroys other agents'
  state. The pattern: `CREATE SCHEMA zz_<run>`, `CREATE TABLE zz_<run>.<t>
  (LIKE public.<t> INCLUDING ALL)` for every table the path writes, give each
  cloned `id` a sequence inside the temp schema (`LIKE` copies the DEFAULT
  verbatim, which still names `public`'s sequence), point the pool at it with
  `options: '-c search_path=zz_<run>'`, and `DROP SCHEMA ... CASCADE` in
  `after()`. `LIKE` does not copy foreign keys, which was fine here.

Related: [[signup-admission-lives-in-the-store]].
