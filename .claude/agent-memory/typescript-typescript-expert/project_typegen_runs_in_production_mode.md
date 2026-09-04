---
name: typegen-runs-in-production-mode
description: react-router typegen evaluates app/routes.ts with NODE_ENV=production, so a dev-only route gets no ./+types file
metadata:
  type: project
---

`pnpm typecheck` is `react-router typegen && tsc`, and inside typegen
`process.env.NODE_ENV` is `'production'`. A route registered as
`...(process.env.NODE_ENV === 'production' ? [] : [route(...)])` is therefore
absent from typegen too, and `import type { Route } from './+types/<name>'`
fails with TS2307 even though the route renders fine under `pnpm dev:server`.

**Why:** it reads as a broken typegen and sends you looking at tsconfig.

**How to apply:** a dev-only route takes its data with `useLoaderData<typeof loader>()`
and declares `export async function loader()` with no `Route.LoaderArgs`. The
prod build (`cross-env NODE_ENV=production react-router build`) drops the route
for the same reason, which is the point: grep `build/server/index.js` to confirm.
Related: [[translate-public-surface-contract-m184]].
