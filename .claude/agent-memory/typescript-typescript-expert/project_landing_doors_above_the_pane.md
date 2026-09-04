---
name: landing-doors-above-the-pane
description: landing.tsx exports LandingDoors (hero h1, no card), LandingExampleCard (goes in SearchPanes' emptyPane) and LandingPrivacyNote; the pitch list is gone
metadata:
  type: project
---

`app/components/landing.tsx` exports THREE components since the empty-query
relayout (2026-09-04):

- `LandingDoors()` — a plain block, NOT a card. An `h2` carrying
  `landing.heading` at a hero type scale, a `max-w-prose` body line, then
  `/sign-up` as a button and `/sign-in` as a link. Rendered by `search.tsx`
  ABOVE `SearchPanes`, only for `q === '' && !signedIn`. It is an `h2` and not
  an `h1` because the app shell's header already renders the route title as
  this page's `h1`; a browser walk found both. The test asserts
  `doesNotMatch(/<h1/)` on the route's own markup.
- `LandingExampleCard({ example })` — the `h3` plus `SearchResults`. It is
  passed to `SearchPanes` as `emptyPane`, for anonymous AND signed-in readers.
- `LandingPrivacyNote()` — one `<p>`, no props: `landing.privacy` +
  `landing.privacyPlaintext` + the `/legal/privacy` link. Below the panes,
  anonymous only.

`SearchPanes` takes `emptyPane?: ReactNode` and renders it inside the existing
`<section aria-live="polite">` when `q === ''`.

**Why:** the old shape stacked a full-width bordered card, a half-width grid
with an EMPTY right column, three loose pitch sentences and a second full-width
card. Widths jumped full/half/full and three blocks described the product in
slightly different words. The example moved into the output pane so the desktop
first visit has no hole; the pitch list was deleted, and `landing.search` and
`landing.lists` were removed from BOTH locale files with it.

**How to apply:** `tests/integration/anonymous-front-door-doors.test.ts` slices
the `aria-live="polite"` section out of the markup and asserts the example is
INSIDE it. A whole-document `includes` would pass with the example back below
the panes, so keep the slice. Related:
[[search-panes-is-the-shared-surface]], [[render-a-route-component-in-a-test]],
[[voice-hint-waits-for-a-transcription]].
