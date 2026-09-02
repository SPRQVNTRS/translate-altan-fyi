---
name: one-projection-decides-the-blob-keys
description: toSyncedSnapshot is the only projection onto the blob's collections, and readLocalSnapshot takes { store } so a test can drive the live path
metadata:
  type: project
---

`app/lib/local-store/blob-schema.ts`'s `toSyncedSnapshot` takes a
`SyncedSnapshot` (the narrow three-collection shape) and is the ONE place that
names the collections the encrypted blob carries. A full `LocalStoreSnapshot`
is assignable to that parameter, so the device export path and the live sync
path share one projection. `app/lib/sync/local-store-bridge.ts`'s
`readLocalSnapshot` assembles the three `list*IncludingDeleted` reads and hands
them to it instead of building the payload itself.

`readLocalSnapshot({ store }: StoreOption = {})` threads the store to all three
reads, so a unit test drives the REAL function against an in-memory TinyBase
store. `tests/unit/personal/blob-serializer.test.ts` does exactly that, and its
tombstone case is falsified: filtering `deleted` rows out of `readLocalSnapshot`
turns it red. `StoreOption` is declared per file in this codebase (primary-store.ts,
history.ts, migration-gate.ts each declare their own); the bridge follows that
rather than exporting one.

**Why:** the search log's exclusion used to rest on a hand-written collection
list in the bridge that no test covered, while the tested projection had zero
callers. Fixed 2026-09-02.

**How to apply:** `blob-schema.ts` must contain ZERO occurrences of the token
`history` — a verification check greps it and requires 0. Say what is left out
in `local-store-bridge.ts` or the barrel, and point at
`app/lib/e2ee/BLOB-CONTENTS.md`. `withSyncedSnapshot`, the unused inverse, was
DELETED on 2026-09-02 rather than kept: an unexercised second projection is a
second shape nothing checks. The merge path writes through
`writeMergedSnapshot`, which replaces the three synced tables and leaves the
search log alone.
Related: [[local-store-barrel-is-the-one-seam]], [[e2ee-copied-not-extracted]].
