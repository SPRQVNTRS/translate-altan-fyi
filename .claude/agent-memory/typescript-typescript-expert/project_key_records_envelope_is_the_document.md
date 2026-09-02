---
name: key-records-envelope-is-the-document
description: the /api/v1/sync/key-records response shapes follow PROTOCOL.md 5.3/5.4 (records list, bare PUT record), and the 409 keeping an extra error key is deliberate
metadata:
  type: project
---

`app/routes/api.v1.sync.key-records.ts` answers `{ records: [...] }` on `GET`
and the stored record BARE (`{ kind, kdfDescriptor, wrappedDek, updatedAt }`,
no wrapper key) on `PUT` 200. The `409` intentionally carries BOTH `error` and
`currentUpdatedAt`: section 5.4's table lists only `currentUpdatedAt`, section 4
says every non-2xx body is `{"error": "..."}`, so the pair is a superset rather
than a drift.

**Why:** the port originally wrapped these as `{ keyRecords }` / `{ keyRecord }`
and the client schema was transcribed from the route instead of the document.
`PROTOCOL.md` and `openplate-sync/src/server/register-routes.ts` agreed with
each other, so THIS repo was the wrong one. Fixed 2026-09-02.

**How to apply:** `PROTOCOL.md` is normative for every sync/auth wire shape —
transcribe from it and from upstream, never from the local route. `keyRecords`
is still a legitimate REQUEST field on `POST /v1/auth/recover-rotate` and
`/change-passphrase` (section 5.14); a different field on a different endpoint,
leave it alone. See [[e2ee-copied-not-extracted]].
