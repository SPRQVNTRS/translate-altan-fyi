---
name: sync-client-schemas-pin-the-document
description: all four sync-client wire schemas are exported so tests can pin them against PROTOCOL.md literals; keep any new one exported
metadata:
  type: project
---

`app/components/sync/sync-client.ts` exports `kdfResponseSchema` (5.7),
`sessionSchema` (5.8), `keyRecordsResponseSchema` (5.3) and
`keyRecordResponseSchema` (5.4). The last two were made public on 2026-09-02;
nothing about parsing changed. All four are now pinned in
`tests/unit/sync-ui.test.ts`, each with the port's wrapper as the negative half.

**Why:** these schemas are reachable only through `signInToSync` /
`createSyncAccount`, behind Argon2 and three endpoints, and `requestJson`
closes over the global `fetch` with no injection point. Exporting them is the
only way a unit test can parse a literal transcribed from `PROTOCOL.md`. The
port already drifted once (`{keyRecords: ...}` / `{keyRecord: ...}`, fixed in
`14bf27f`), which is the ADR-0008 copy risk in the concrete.

**How to apply:** any new wire schema in this file is exported and gets a
docblock naming its `PROTOCOL.md` section, so `tests/unit/sync-ui.test.ts` can
pin it. Related: [[key-records-envelope-is-the-document]],
[[e2ee-copied-not-extracted]].
