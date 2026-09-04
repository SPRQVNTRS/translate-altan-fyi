---
name: sign-out-wipes-via-clientaction
description: /sign-out is POST only and its clientAction does the device wipe, in a fixed order, before calling serverAction
metadata:
  type: project
---

`app/routes/sign-out.tsx` empties the device. Only the browser can delete
IndexedDB, so the order is driven from a `clientAction`:

1. one sync attempt (needs the cookie the server is about to destroy),
2. `clearSyncSession()`, so no trigger starts a cycle mid-wipe,
3. `wipeDeviceStore()` (`app/lib/local-store/wipe.ts`, deletes BOTH databases),
4. `postMessage({ type: 'CLEAR_CACHE' })` to the service worker, because
   `/account` is in the precached shell and its HTML carries the address,
5. `serverAction()` last.

**Why:** `serverAction()` THROWS the redirect the server answers with, so
nothing after it in that function runs. Step 1 also needs the live cookie.

**How to apply:** never reorder these, and never move the wipe into the server
action. `/logout` was deleted with M191/03; `/sign-out` replaced it. The loader
answers a GET with a redirect and changes nothing, because a URL that signs you
out is a URL an image tag can visit.
