---
name: local-store-barrel-is-the-one-seam
description: import from #app/lib/local-store only; getPrimaryStore is re-exported from the barrel for SUBSCRIBING, and reaching into persist.ts bypasses the save lock
metadata:
  type: project
---

`#app/lib/local-store` (the `index.ts` barrel) is the ONLY seam into the
device's data. `getPrimaryStore` is re-exported there, so nothing needs to deep
import `#app/lib/local-store/persist`.

**Why:** the barrel's functions are what take `persist.ts`'s save lock, dedupe
autosaves and keep the schema-version value honest. A caller holding the raw
store handle can write past all three, which is the parallel writer
`app/lib/sync/local-store-bridge.ts`'s header exists to prevent. The scheduler
deep-imported it until 2026-09-02.

**How to apply:** take the handle only to SUBSCRIBE (`addTablesListener`),
never to write. A subscription is neither a read nor a write, so no entity
function can express it, and that is the single legitimate reason the handle is
exported at all.
