---
name: translate-dev-seed-m192
description: drizzle/seed.ts now seeds one verified local dev account; guard order and hashing-reuse constraints to remember
metadata:
  type: project
---

`drizzle/seed.ts` turns into a real local-dev seed: one idempotent, verified
`users` row (`SEED_EMAIL`/`SEED_PASSWORD`, default `dev@localhost` /
`devpassword`), `isSuperadmin: true`, never touches the dictionary tables.

**Guard-before-pool needs a dynamic import, same as `cli/index.ts`.** A static
`import { closePool } from './db'` at the top of the file is hoisted above any
guard code by ESM, so `db.ts`'s pool (and its `poolInitialized` promise) would
open before `NODE_ENV`/`DB_HOST` are checked. `cli/index.ts` already solved
this exact ordering problem for a different reason (LOG_LEVEL before the
logger is built) with a dynamic `import()` inside an async function. Reused
that precedent here rather than inventing a new pattern; oxlint's anti-slop
gate does not flag it.

**`app/services/auth.server.ts` has no reusable "just hash a password"
export.** `BCRYPT_COST` is a private module constant (value `10`, confirmed in
`AGENTS.md` too), and every exported function does more than hash (mails a
link, or never sets `emailVerifiedAt`). The seed duplicates the literal `10`
with a comment pointing at the source of truth, rather than importing the
module. auth.server.ts itself *is* safely importable from a plain tsx script
(session.server's `CONFIG.session.secret` getter falls back to `'s3cr3t'`
outside production, so no throw at import time) — it just has nothing to
import for this job.

See also [[project_translate_plain_accounts_m191]] for the `users` schema
shape this seed writes into.
