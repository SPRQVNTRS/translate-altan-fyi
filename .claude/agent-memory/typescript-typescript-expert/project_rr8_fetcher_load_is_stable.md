---
name: rr8-fetcher-load-is-stable
description: In React Router 8 the useFetcher object is new each render but fetcher.load is a stable useCallback, so it is safe in a useEffect dep array
metadata:
  type: project
---

`useFetcher()` returns a fresh object every render (a `useMemo` over `fetcher`
and `data`), but `load` is a `useCallback` keyed on `fetcherKey`, `routeId` and
`router.fetch`. All three are stable, so `fetcher.load` does NOT change identity
between renders.

**Why:** verified in
`node_modules/react-router/dist/development/lib/dom/lib.js`, `useFetcher`.
It matters for polling: putting the whole `fetcher` in a `useEffect` dep array
tears down and restarts the interval on every render, so the timer never reaches
its delay and no poll ever fires. Naming `fetcher.load` instead is safe and
needs no ref.

**How to apply:** poll with `const load = fetcher.load` and deps
`[isPolling, url, load]`, where `isPolling` is a BOOLEAN. Never depend on an
attempt counter, or the interval restarts on every tick.

Related: [[translate-altan-fyi-stack]]
