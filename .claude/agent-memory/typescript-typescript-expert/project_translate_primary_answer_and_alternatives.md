---
name: translate-primary-answer-and-alternatives
description: The translation card has one primary row and tappable alternatives; the choice is ephemeral client state held beside the pane machine, and translationPaneText now takes a chosenId and returns ONE lemma
metadata:
  type: project
---

M196 wave 2. `translationPaneText(state, chosenId)` returns the PRIMARY lemma
alone, and the old join moved to `translationPaneAllText(state)`. That one
signature change is the fix: the copy button, the favourite snapshot
(`translationSnapshot={resultText}` in `search-panes.tsx`) and `RecordSearch` in
`routes/translate.tsx` all read `controller.text`, so all three stopped dragging
every candidate along without any of them being edited.

The pure seam is four functions in `app/lib/translation/pane-state.ts`:
`translationPanePrimary`, `translationPaneAlternatives`, `translationPaneText`
(all `(state, chosenId)`) and `translationPaneAllText(state)`. An unknown
`chosenId` falls back to `rows[0]`, NEVER to null: a poll can land a new row set
under a held choice, and an answer card that empties itself is worse than the
defect.

**Why the chosen id is `useState` in the hook and not in `TranslationPaneState`:**
two reviewers rejected the first draft, which reordered by the reader's own
vote. A vote is a statement about the shared corpus, selection is a view action;
fusing them means two readers see two different primary answers. So the tap
writes nothing and posts nothing, and the id decides none of the six values
`translationPaneView` returns, which is what keeps the one-state-value rule
intact. It is reset in the existing render-time re-seed, not in an effect.

**How to apply:** an alternative's lemma is a `<button>` and the vote control
sits BESIDE it, never inside, or the markup is invalid and the vote swallows the
selection. `controller.rows` is now read by nothing and is kept only as the
undivided list; do not render it flat again. `ResultField` takes `text`,
`allText` and `hasAlternatives`, and both copy buttons are one `CopyButton`
component so the `navigator.clipboard` guard is written once.

Related: [[translate-rank-is-the-one-order]],
[[translate-candidate-note-prompt-v2]], [[search-panes-is-the-shared-surface]]
