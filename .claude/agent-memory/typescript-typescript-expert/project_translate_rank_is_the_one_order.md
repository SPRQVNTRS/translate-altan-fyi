---
name: translate-rank-is-the-one-order
description: rankTranslationRows is the single reading order for a translation answer; myVote is not a sort key and the vote margin is 2
metadata:
  type: project
---

`app/lib/translation/rank.ts` (M196) owns the order the answer rows are read
in, and `listTranslationsInto` calls it on the DEDUPLICATED array before
returning. The SQL `ORDER BY` was NOT changed and must not be: it encodes the
dedupe preference (imported wins over generated for the same lemma+pos), so
reordering it hands every duplicate to the model. Two questions, one statement.

Precedence: imported before generated, then `up - down` descending but only once
`Math.abs(net) >= VOTE_MARGIN_THRESHOLD` (2), then confidence descending with
`null` last, then `lemma.localeCompare`.

**Why:** `myVote` is deliberately not a key, or two readers would see two
different primary answers and the shared corpus view would become a personalised
one. The margin of 2 is the bounded amendment to M194 decision 8 ("a vote is
recorded and nothing else"): one drive-by vote cannot flip a low-traffic
headword.

**How to apply:** the module is client-reachable, so it may import TYPES only
(the `TranslationRow` type-only import from `translations-query.server` is the
established pattern, same as `pane-state.ts` importing from `panel.server`).
Adding a field to `TranslationRow` breaks fixtures in five unit files:
`translation-panel-gate`, `translation-pane-state`, `translation-pane-branches`,
`phrase-panel-gate` and `translation-rank`.

Related: [[project_translate_favourites_history_votes]],
[[project_the_translator_surface_is_one_column]]
