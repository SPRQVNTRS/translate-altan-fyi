---
name: translator-surface-is-one-column
description: The /translate surface is one flex column at every width, the language bar is a grid-cols-[1fr_auto_1fr] grid, and both cards are plain rounded-2xl border p-5 with no surface-brand
metadata:
  type: project
---

`SearchPanes` is one flex column, `gap-4`, at every viewport: language bar,
input card, result region. `md:grid-cols-2` is gone, the `<Form>` is an ordinary
`flex flex-col gap-4` box rather than `display: contents`, and
`routes/translate.tsx` wraps in `max-w-2xl` with no `md:max-w-5xl`. The language
bar is `grid grid-cols-[1fr_auto_1fr]`; a flex row is banned there.

**Why:** the bar was a wrapping flex row over a CSS grid, and two layout systems
cannot align their vertical edges. Measured at 1280px, each select sat 14px out
of line with the card it labelled, and `flex-wrap` dropped the target select
onto its own line on a phone. The operator chose the DeepL mobile shape: one
layout to get right instead of two. DESIGN.md section 3 is normative for it and
section 10 bans both the second column and `flex-wrap` on a row that has to line
up with something below it.

**How to apply:**

- Neither card carries `.surface-brand` any more, and that reverses the old
  "the input pane is the only element allowed it" rule. The two cards must stay
  byte-identical class lists, `rounded-2xl border p-5`.
- Raising a shared primitive's height needs the primitive's own variant named
  too: `SelectTrigger` sets `data-[size=default]:h-9`, and a variant utility
  outranks a plain `h-11`, so the 44px triggers carry `h-11
  data-[size=default]:h-11` or tailwind-merge leaves both and the 36px wins.
- `SelectValue` is laid out `flex` by the shared trigger, and `text-overflow`
  does nothing to a flex container, so a narrow cell clipped the label mid-word.
  `*:data-[slot=select-value]:block *:data-[slot=select-value]:truncate` is what
  buys the ellipsis.
- `tests/unit/search-panes-language-bar.test.ts` now guards the layout. Its
  cases read `className="..."` ATTRIBUTES rather than the file text, because
  both files explain the old grid and the old wrap in prose and a plain
  `includes` would fail on the comment recording the fix.

Related: [[search-panes-is-the-shared-surface]],
[[landing-doors-above-the-pane]], [[language-pair-is-stated-not-pinned]].
