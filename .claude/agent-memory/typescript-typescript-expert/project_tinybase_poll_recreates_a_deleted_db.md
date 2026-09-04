---
name: tinybase-poll-recreates-a-deleted-db
description: deleteDatabase alone never wipes the device; TinyBase's 1s auto-load poll opens the database versionless and re-creates it, so the persisters must be destroyed first
metadata:
  type: project
---

`createIndexedDbPersister(store, dbName, autoLoadIntervalSeconds = 1, ...)`
polls once a second, and each poll calls
`indexedDB.open(dbName, create ? 2 : undefined)` with `create = 0`. A
versionless open CREATES an absent database.

**Why:** so `indexedDB.deleteDatabase()` succeeds and the next poll, under a
second later, re-creates an empty v1 with no object stores. The 2026-09-04
browser walk signed out and still found `translate-primary` and
`translate-outbox`; the console warning `One of the specified object stores was
not found` is the re-created empty database answering the poll after it. The
poll is also what makes a delete arrive `blocked`.

**How to apply, and there are THREE parts, not one:**

1. `closePersistedStores()` (`app/lib/local-store/persist.ts`) removes the
   listeners, AWAITS the in-flight save loop, THEN calls `persister.destroy()`,
   and nulls the singletons LAST. `startLockedAutoSave` returns
   `() => Promise<void>` for that drain and is idempotent.
2. **`persister.save()` after `persister.destroy()` resolves THROWS**
   `Cannot read properties of undefined (reading 'splice')`, reproduced against
   TinyBase 9.5.1. `destroy()` drops the schedule reference count to zero and
   `pruneSchedule` DELETES the action array (`mapSet` with no value is a
   delete); a later `save()` pushes onto `undefined`. That is why the drain
   comes first, and it is what the walk saw as
   `local-store: locked autosave failed`.
3. **Nothing may re-open the store when there is no session**, or the poll
   re-creates the database seconds later and again after a reload. Gated:
   the scheduler's `attachStoreListener`, `DailyNudge` on `/`, and the export
   card on a signed-out `/account`. The first two ran for EVERY visitor, which
   is why `translate-primary` came back while `translate-outbox` stayed gone.

`wipeDeviceStore()` awaits the close BEFORE issuing any delete, and a unit test
asserts that ORDER on a recorded log, because every other assertion about the
wipe passes on the broken build.
Related: [[project_sign_out_wipes_via_clientaction]].
