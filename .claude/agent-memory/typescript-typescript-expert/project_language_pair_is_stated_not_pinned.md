---
name: language-pair-is-stated-not-pinned
description: The translator's language pair lives in app/lib/dictionary/language-pair.ts, is browser-safe only because it imports no VALUE from detect-language, and replaced the direction-pinning bug
metadata:
  type: project
---

The language pair is an explicit control (`LanguageBar`), not a guess plus a
flip link. `app/lib/dictionary/language-pair.ts` owns `DETECT`, `LanguagePair`,
`LANGUAGE_NAMES` (the ONE table naming languages, `VOICE_LANGUAGES` derives
from it), the `translate-pair` cookie and `resolveLanguagePair` (URL, then
cookie, then `DEFAULT_PAIR`, applied per side, with `target === source`
repaired).

**Why:** `SearchPanes` used to write `from`/`to` into hidden inputs whenever
`!direction.detected`, so one tap on `DirectionChip` pinned that direction into
every later submission and a German word typed afterwards searched the English
side silently. Hit in production.

**How to apply:** that module must import from `detect-language.ts` with
`import type` ONLY. A value import pulls `#drizzle/schema` and
`@sprqvntrs/workflows/schema` into the client bundle, which is why
`PAIR_LANGUAGES` and `partnerLanguage` are written out there instead;
`tests/unit/language-pair.test.ts` asserts parity with `SERVED_LANGUAGES`.
`from=detect` needs no server branch: `chooseDirection` ignores any unserved
`from`. See [[store-values-do-not-bump-schema-version]].
