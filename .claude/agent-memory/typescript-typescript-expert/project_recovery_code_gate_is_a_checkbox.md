---
name: recovery-code-gate-is-a-checkbox
description: the recovery-code save gate is a checkbox re-checked by the reducer, not a retype; recovery-confirmation.ts and its retype tests were deleted
metadata:
  type: project
---

`CreateAccountFlow`'s final screen gates completion on a CHECKBOX
(`confirmSavedToggled`), and `syncSetupReducer` re-checks `hasConfirmedSaved`
before it will leave `show-account-card`. There is no retype of the code.

`app/components/sync/recovery-confirmation.ts` and its
`isRecoveryCodeConfirmed` were deleted on 2026-09-04 with the four retype cases
in the old `sync-ui.test.ts`: nothing but that test imported the module.

**Why:** the retype tested typing accuracy; what has to be tested is that the
person holds a copy at all.

**How to apply:** the gate is still a security rule and still lives in the
reducer, so it stays testable without a DOM. Test it through
`syncSetupReducer`, and keep the case asserting that no OTHER action leaves the
account card. See [[account-components-directory]].
