---
name: role-img-is-banned-on-an-inline-svg
description: jsx-a11y/prefer-tag-over-role rejects role="img" on any element, so the Kenning mark names itself with aria-label plus a <title> child
metadata:
  type: project
---

`app/components/kenning-mark.tsx` cannot carry `role="img"`. oxlint's
`jsx-a11y/prefer-tag-over-role` fires on the attribute for ANY element,
including a foreign `<svg>`, and the gate is not negotiable.

The accessible name is therefore `aria-label={APP_NAME}` plus a `<title>` first
child. A screen reader that ignores `aria-label` on a role-less `<svg>` still
reads the title.

The mark's two brand fills (`#F9A918`, `#F85B46`) are the ONE sanctioned
exception to DESIGN.md section 10's ban on raw colour in components: a logo is
artwork, and the palette was read off the mark rather than the other way round.
The stroke is the GAP between the cards, `var(--mark-gap, #FFFEFD)`, and its
geometry must stay identical to `public/icons/icon.svg`.

**How to apply:** the mark renders in `public-wrapper.tsx`'s header and in
`app-sidebar.tsx`'s `Logo` (both rail states). The wordmarks in
`app-wrapper.tsx` are text, not the mark.
