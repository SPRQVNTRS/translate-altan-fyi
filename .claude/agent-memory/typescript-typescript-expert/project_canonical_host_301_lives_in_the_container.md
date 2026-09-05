---
name: canonical-host-301-lives-in-the-container
description: kenning.altan.fyi is canonical and translate.altan.fyi is legacy; the 301 is an Express middleware in server.ts because Bay runs no redirect middleware
metadata:
  type: project
---

Traefik routes BOTH `kenning.altan.fyi` and `translate.altan.fyi` (and both
`stage.` forms) to the one container, and nothing in front of the app rewrites a
host. So the canonical-host 301 is `app.use(...)` in `server.ts`, above the
React Router handler, calling the pure `canonicalHostRedirect({ host, path })`
in `app/lib/canonical-host.ts`.

Three things that are load-bearing:

- The host comes from `req.hostname`, which respects `trust proxy`. Reading
  `x-forwarded-host` directly would read a client-written header, the same trap
  the `x-client-ip` block above it exists to avoid.
- The mapping is a SUFFIX SWAP on a dot boundary, so one rule covers the apex
  and `stage.`. A bare `endsWith` would also capture `nottranslate.altan.fyi`.
- `/healthcheck` is excluded. A prober that does not follow redirects reads a
  301 as an outage.

**Why the function is separate:** `server.ts` opens a listener, a pool and the
orchestrator at import, so a unit test cannot import it.
`tests/unit/canonical-host.test.ts` tests the function instead.

Related: [[bay-canonical-host-redirect-in-container]] in the user memory.
