---
name: store-values-do-not-bump-schema-version
description: Adding a TinyBase store VALUE needs no SCHEMA_VERSION bump; only entity shapes are versioned, and values never enter the blob or the backup
metadata:
  type: project
---

`SCHEMA_VERSION` in `app/lib/local-store/schema.ts` versions the five ENTITY
collections. Store VALUES (`nudgeShownOn`, `lastExportAt`, `deviceId`,
`migrationGateClearedFor`, and now `sourceLanguage`/`targetLanguage`) sit
outside it: `backup.ts` serializes collections only, `blob-schema.ts` projects
four collections only, and `migration-gate.ts` is an unrelated device stamp.

**Why:** v2 was added for `LocalReviewState`, an entity. The nudge marker was
added later as a value with no bump, and nothing broke, because no envelope and
no blob carries it.

**How to apply:** a new device preference is a value: constant in `schema.ts`,
re-export through `store.ts` and `index.ts`, a `nudge.ts`-shaped module with a
zod-validated read, and no version bump. State the not-synced reason in the
header comment. See [[language-pair-is-stated-not-pinned]].
