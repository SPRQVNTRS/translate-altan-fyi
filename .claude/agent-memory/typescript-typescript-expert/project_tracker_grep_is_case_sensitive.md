---
name: tracker-grep-checks-are-case-sensitive
description: A tracker check grepping for lowercase prose fails against an ALL-CAPS house-style comment heading
metadata:
  type: project
---

Tracker verification checks in `.tracker/` use plain `grep`, which is case
sensitive, while this repo's comment register writes the topic sentence in
CAPITALS (`// WHAT PHRASE-FIRST COSTS: ...`). A check written as
`grep -n "phrase-first" ...` with `Expected: stdout matches /phrase/i` then
finds nothing, or finds only a continuation line that does not carry the word.

**Why:** the `Expected` clause tests the MATCHED LINE, not the file, so a
multi-line comment can satisfy a grep on one line and fail the Expected
pattern on that same line.
**How to apply:** when a spec's grep names lowercase prose, put that exact
lowercase phrase into the comment body on a single line, and re-run the
check verbatim rather than assuming the topic heading covers it.
Related: [[translate-node-test-summary-never-in-tail-5]].
