---
name: install-entry-is-a-catalog-action
description: the nav install row is installNavigationAction plus useInstallPrompt, absent until mount, never disabled
metadata:
  type: project
---

Installing the app is offered in three places from ONE detection:
`app/hooks/use-install-prompt.ts`. `install-app.tsx` (the `/settings` card),
`app-sidebar.tsx` and the drawer in `app-wrapper.tsx` all read it.

`useInstallPrompt` starts at `{ kind: 'unavailable' }` and only an effect moves
it. That is the whole design: reading `navigator` or `matchMedia` during render
gives the server one answer and the client another, React keeps the server's
markup, and the reader is left with a permanently inert control
([[ssr-env-probe-ships-a-dead-control]] is the same defect elsewhere). The rows
render only on `ready`, so they are ABSENT rather than disabled. iOS gets
`manual`, which is the settings card's sentence and no nav row, because there is
no install API to fire there.

`installNavigationAction` lives beside `navigationItems` in `app-sidebar.tsx`,
which DESIGN.md section 6 makes the one catalog. It is NOT a member of that
array: it has no `to`, so `activeNavigationHref` and the tab bar never see it.
Its label reuses `settings.installTitle`, so no new copy was needed (section 9
rule 7, one phrasing per idea).
