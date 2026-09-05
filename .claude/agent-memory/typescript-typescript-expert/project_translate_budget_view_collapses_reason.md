---
name: translate-budget-view-collapses-reason
description: pane-state.ts's TranslationPaneView has one 'budget' value for all three refusals; the reason lives on state.panel, read in translation-pane.tsx not pane-state.ts
metadata:
  type: project
---

`app/lib/translation/pane-state.ts`'s `translationPaneView` deliberately
collapses `TranslationRefusal` (`'rate-limited' | 'budget' | 'daily-cap'`) to
one `'budget'` view value — the reducer/view module owns layout, not copy.
To render different sentences per refusal (rate-limited needs
`enrichment.rateLimited`, the other two keep `translation.budget`), read the
reason out of the hook's own held `state.panel` in
`app/components/translation-pane.tsx` (`state.panel.state === 'budget' ?
state.panel.reason : null`) and expose it as a new `refusalReason` field on
`TranslationPaneController`, rather than changing `pane-state.ts`.

The copy choice itself is a pure function, `translationBudgetKey(reason)`,
exported from `translation-pane.tsx` — this repo has no DOM test library
([[project_account_components_directory]] / see `account-ui.test.ts`'s own
header comment), so a render-level assertion has to be a plain function test,
not a rendered-output test. `tests/unit/translation-pane-state.test.ts`
imports it directly from the `.tsx` file; precedent for importing components
into `tests/unit/*.test.ts` already exists (`voice-input.test.ts`,
`sidebar-admin-link.test.ts`) because `test:unit` runs under `node --import
tsx`, which transforms JSX, unlike the bare strip-types path used elsewhere in
this repo's CLI tests.
