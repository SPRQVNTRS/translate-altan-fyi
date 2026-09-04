---
name: tailwind4-theme-vars-resolve-at-root
description: Tailwind 4 derives --color-* from the raw HSL tokens at :root, so scoping a palette override on a nested element needs BOTH the raw token and the --color-* line
metadata:
  type: project
---

In `app/app.css` the `@theme` block declares `--color-primary: hsl(var(--primary))`
on `:root`. A custom property is substituted where it is DECLARED, so redefining
`--primary` on a nested wrapper leaves `--color-primary` at the value it already
computed at the root: every `text-primary` / `bg-background` utility keeps
painting the old teal while the wrapper claims a new hue.

**Why:** M186's `/dev/design-review` previewed three blue palettes and rendered
three teal ones, and the only visible symptom was that the accents "looked a bit
teal". `.surface-brand` DID change, because it reads `hsl(var(--primary) / 0.18)`
at the element.

**How to apply:** a scoped palette must emit both `--token: <triplet>;` and
`--color-token: hsl(<triplet>);`. Applied at `:root` (the real change) one line
is enough, because the derivation then happens in the right order.
`--font-display` has no such problem: it holds a literal, not a `var()`.
