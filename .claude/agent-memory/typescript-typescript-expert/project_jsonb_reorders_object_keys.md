---
name: jsonb-reorders-object-keys
description: sync_blobs.payload is jsonb, so a round-trip test cannot assert literal bytes; sort keys and compare the canonical encoding
metadata:
  type: project
---

`jsonb` stores a PARSED value: it drops insignificant whitespace, keeps the last
of any duplicate key, and returns object keys in its own order (shortest first,
then by name). `JSON.stringify(pulled) === JSON.stringify(pushed)` fails on a
document that survived perfectly.

**Why:** the M191 spec asks for a "byte-identical" round trip, and the literal
reading of that is untestable against this column.

**How to apply:** in `tests/integration/personal-sync-push.test.ts`, compare a
key-sorted encoding (`canonicalJson`). It still catches a changed value, a
changed TYPE, a dropped key and an added one, which is everything that matters.
Ignoring key order is SAFE here because nothing downstream reads it:
`parseEnvelope` decodes with a schema and `payloadsEqual` builds its own
canonical form in `snapshot-sync.ts`. Leave ARRAY order alone.
