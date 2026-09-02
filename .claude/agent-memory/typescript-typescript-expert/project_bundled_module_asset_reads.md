---
name: translate-altan-fyi-bundled-module-asset-reads
description: In translate-altan-fyi, import.meta.url-relative file reads break only in the built server, and only a route-graph edge puts them on the boot path
metadata:
  type: project
---

A module that reads a non-code asset with
`readFileSync(fileURLToPath(new URL('./x.md', import.meta.url)))` is correct under
`tsx` and WRONG in production. `react-router build` bundles the module into
`build/server/index.js`, `import.meta.url` moves with it, and the bundler never
emits the asset. Resolve with a fallback list: the `import.meta.url` location
first, then `path.resolve(process.cwd(), '<repo-relative path>')`. The second one
holds in the image because `Dockerfile.pnpm`'s final stage inherits `COPY . /app`
with `WORKDIR /app`.

Two follow-ons, both load-bearing:
- Do the read LAZILY, inside the function that needs it, and memoise. At module
  scope the failure kills the boot before the server listens.
- Check what drags the module into the ROUTE bundle. A static
  `import { getOrchestrator } from '#app/services/workflows.server'` pulls
  `registerAllWorkflows`, every template and every operation handler behind it.
  A dynamic `await import(...)` inside the calling function cuts that edge.

**Why:** `pnpm lint`, `typecheck`, `test:unit` and `build` all stay green; they
run the unbundled sources or never start the server. Only `pnpm start` against
the built output shows it. See ADR-0004.
**How to apply:** when adding any `readFileSync` of a shipped asset under `app/`,
or any static import from a `.server.ts` that a route touches.
Related: [[translate-altan-fyi-verify-commands]], [[oxlint-anti-slop-patterns]].
