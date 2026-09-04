---
name: auth-doors-left-the-app-shell
description: the five account doors render under _auth-shell (PublicWrapper), not the app shell, because AppWrapper's 256px sidebar pushed a max-w-md card 128px off the viewport centre
metadata:
  type: project
---

`/sign-up`, `/sign-in`, `/verify-email`, `/forgot-password` and
`/reset-password` sit under `app/routes/_auth-shell.tsx`, which renders
`PublicWrapper` (the `/legal/*` chrome). `/account` STAYS in `_app`.

**Why:** `AppWrapper` opens a 256px navigation sidebar for everybody, so a
`max-w-md` card centres in the leftover column. A browser walk measured the
sign-up card at x=768 against a viewport centre of 640. No amount of centring
inside the card fixes it: the container is the wrong one.

**How to apply:** two consequences. `AuthCard` takes `headingLevel`, defaulting
to `h1`, because `PublicWrapper` draws no page heading while `AppWrapper` does,
and `/account` passes `h2`. And use the UNDECORATED typography variants
(`subtlePageHeader`, `subSectionHeader`): `H1`'s default carries `lg:text-5xl`,
which `cn` cannot merge away against a base-breakpoint `text-lg`, and `H2`'s
default carries `border-b pb-2`, which draws a rule across the card.

Verify without a browser: `curl` each path and count `data-slot="sidebar"`. It
is 0 on the five doors and 1 on `/account` and `/`.
