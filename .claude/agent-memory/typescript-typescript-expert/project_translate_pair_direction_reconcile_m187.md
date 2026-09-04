---
name: translate-pair-direction-reconcile-m187
description: translate.tsx's loader must hand SearchPanes reconcilePairWithDirection(pair, direction), not raw pair
metadata:
  type: project
---

A browser walk found `?from=detect&to=de&q=umwerfen` showing "Deutsch" on the
bar while every result link carried `?to=en`. Cause: `resolveLanguagePair`
only repairs a target that collides with a STATED source; `from=detect`
states none, so nothing collides at resolve time, and `chooseDirection` later
sends the search to `partnerOf(detectedSource)`, which the pair never learned
about.

Fix: `reconcilePairWithDirection(pair, direction)` in
`app/lib/dictionary/language-pair.ts` returns `{ source: pair.source, target:
direction.to }`. `translate.tsx`'s loader calls it once, right before the
phrase/headwords branch fork, and returns `pair: resolvedPair` from both
non-empty-query branches. The empty-query (landing) branch keeps the raw
`pair` unreconciled on purpose: no search ran, so there is no `direction.to`
to agree with.

Regression coverage: `tests/unit/language-pair.test.ts` (pure function) and
`tests/integration/language-bar-matches-search-direction.test.ts` (drives the
real loader, asserts `pair.target === direction.to`, not the literal `en`,
so it survives dictionary content changes). The integration test is the one
that actually catches the defect class, since the bug was two loader-returned
values disagreeing with each other.

See also [[project_translate_enrichment_idle_states_look_alike]] for the
sibling class of "two things describing the same screen quietly diverge" bug
in this codebase.
