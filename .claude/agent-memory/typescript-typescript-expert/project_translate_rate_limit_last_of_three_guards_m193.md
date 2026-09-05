---
name: translate-rate-limit-last-of-three-guards-m193
description: checkTriggerRateLimit spends a token on every call, so panel.server.ts asks it LAST, right before enqueue
metadata:
  type: project
---

`checkTriggerRateLimit` (`app/lib/abuse/rate-limit.server.ts`) is not a pure
check: every call unconditionally bumps the caller's address and session
counters via `bumpCounter`, allowed or not. Calling it IS the spend.

`translate.tsx`'s loader runs `resolveTriggeredPanel` (enrichment) and
`resolveTriggeredTranslationPanel` (translation) in one `Promise.all` per
single-word search, and **both** call `checkTriggerRateLimit` independently —
so one search that reaches both guards spends two of the twenty
session tokens per hour, not one. Fixing the translation half alone (order:
`isBudgetExhausted` → `countRunsToday` vs `MAX_TRANSLATION_RUNS_PER_DAY` →
`checkTriggerRateLimit`, last, right before `enqueueTranslation`) stops
translation from spending a token on a search the budget or daily cap would
have refused anyway, but does **not** fully close the two-guards-one-search
gap — that would need `app/lib/enrichment/trigger.server.ts` (`refuseTrigger`,
which still asks rate-limit first) changed too, and that file was out of scope
for the M193 fix (see [[project_translate_altan_fyi_shell]]).

`tests/unit/translation-panel-gate.test.ts` asserts the ORDER via a `calls`
log (`mock.module` fakes for each read), not just the returned reason — this
is what catches an implementation that runs all three guards and picks a
winner after the fact.
