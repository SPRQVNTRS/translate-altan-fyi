---
name: cli-boundary-schema-strips-fields
description: cli/lib/schemas.ts is a stripping parse, so a field missing from it is a field the CLI discards even when the server sent it
metadata:
  type: project
---

`cli/lib/schemas.ts` is the CLI's boundary parse, and every schema in it is a
plain `z.object`, which STRIPS unknown keys. A field the API answers with and
this file does not list is not missing, it is discarded, silently, with no error
to read. M196's `note` reached the screen and the HTTP body while
`pnpm cli translate ... -f json` printed rows without it, for exactly this
reason.

**Why:** `resolveTranslateRequest` and `api.v1.translate.ts` pass the whole
`TranslationPanel` through untouched, so layers 1 and 2 of the four-layer pattern
need no edit when a row grows a field. Only layer 3 (this schema) and layer 4
(the printer) do.

**How to apply:** when a row type in `app/lib/translation/` grows a field, add it
to the matching schema here as a REQUIRED key with a nullable value, so a server
that stops sending it fails loudly. `tests/unit/cli-translate-answer-carries-note.test.ts`
pins that for the translate answer. See [[project_sync_client_schemas_pin_the_document]].
