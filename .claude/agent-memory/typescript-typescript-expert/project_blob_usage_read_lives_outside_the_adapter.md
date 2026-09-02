---
name: blob-usage-read-lives-outside-the-adapter
description: Local-only reads against sync_blobs go in their own .server.ts module, never onto the mirrored storage adapter
metadata:
  type: project
---

Reads against `sync_blobs` / `sync_key_records` that exist only in this repo
get their OWN `.server.ts` module. First instance: `readLatestBlobSizeBytes`
in `app/services/e2ee-blob-usage.server.ts`, which the `/account` screen uses
to report stored size.

**Why:** `app/services/e2ee-storage-adapter.server.ts` is a close mirror of
`openplate-sync`'s `db/storage-adapter.ts` (ADR-0008). Its value is that the
few differences from upstream are known and defensible. A local-only method
there makes a drift check argue about a difference that is not drift.

**How to apply:** never call the adapter's `getBlob` to measure usage; it
selects the whole `ciphertext` (up to 2 MiB). Select `size_bytes`, which the
schema carries for exactly this reason, ordered by `blob_version` desc, limit
1. `sync_blobs` is GLOBAL (no `organizationId`, not in `TENANT_TABLES`), so
`getRawDb()` is sanctioned, not a tenancy bypass. See
[[e2ee-copied-not-extracted]] and [[verify-commands]].
