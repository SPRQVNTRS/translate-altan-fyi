# Falsification records

A test suite that has never been seen to fail is a suite nobody has checked.
This file records the runs where a guard was deliberately broken, the assertion
that caught it, and the restoration.

Each entry names the date, the exact command, the injected defect, and the
failing cases BY NAME. A record that says only "the tests went red" proves
nothing, because a syntax error also turns tests red.

## M173/04

**Guard:** the per-language casing and folding matrix,
`tests/unit/locale-fold.test.ts`, over `app/lib/dictionary/locale-fold.ts`.

**Date:** 2026-09-02

**Injected defect:** the Turkish rule was replaced by the plain, locale-free
fold. `FOLD_RULES.tr` was set to `{ caseLocale: 'en', folds: [] }`, which is
what `String.prototype.toLowerCase` and Postgres `lower()` do: `I` maps to `i`
rather than to `ı`, and the dotless `ı` is left alone rather than folded onto
`i` for the search key. Nothing else was changed.

**Command:**

```
toolbox run -c ts-dev env CI=true node --import tsx --experimental-test-module-mocks \
  --test tests/unit/locale-fold.test.ts
```

**Result: 38 tests, 27 passed, 11 FAILED, exit 1.** The failing cases:

- `tr: Iğdır, the city, typed on an English keyboard: every spelling reaches "igdir"`
- `tr: Işık, where the wrong i is what a reader actually types: every spelling reaches "isik"`
- `tr: İstanbul, the dotted capital I: every spelling reaches "istanbul"`
- `tr: I lowercases to the dotless i`
- `tr: İ lowercases to the dotted i`
- `tr: IŞIK keeps its dotless i`
- `tr: İSTANBUL keeps its dotted i`
- `never maps the Turkish I to a dotted i`
- `tr: Iğdır, the city, typed on an English keyboard: both paths produce the same stored form`
- `tr: Işık, where the wrong i is what a reader actually types: both paths produce the same stored form`
- `tr: İstanbul, the dotted capital I: both paths produce the same stored form`

**What the run also taught, which the checklist did not ask for:**

1. The Turkish rows that do NOT involve an i stayed green: `tr: çağdaş` and
   `tr: gönül` pass under the broken rule, because `ç ğ ö ş ü` decompose under
   NFD and the shared mark strip catches them without any language rule. That is
   the correct outcome and it is why the matrix has one row per LETTER CLASS
   rather than one row per language: a single Turkish row built on `çağdaş`
   would have made this whole defect invisible.

2. `keeps the Turkish i letters apart where folding merges them` also stayed
   green, because with the rule removed both sides of its comparison are equally
   wrong. A case that compares two outputs of the same broken function cannot
   detect that function breaking. The cases that caught the defect are the ones
   asserting against a WRITTEN-DOWN expected string.

**Restored:** the file was restored from a copy taken before the edit, and the
same command re-run: 38 tests, 38 passed, 0 failed. `git diff` on
`app/lib/dictionary/locale-fold.ts` after restoration showed no residue of the
injected defect.
