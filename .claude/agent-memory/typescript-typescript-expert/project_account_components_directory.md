---
name: account-components-directory
description: app/components/sync/ was merged into app/components/account/ in M189; the file names split by audience, UI words vs protocol words
metadata:
  type: project
---

There is no `app/components/sync/`. Every file moved into
`app/components/account/` (M189, 2026-09-04) and the UI-facing ones were
renamed to say what they do:

- `create-account-flow.tsx` / `CreateAccountFlow` (was `sync-setup-flow` / `SyncSetupFlow`)
- `sign-in-form.tsx` / `SignInForm` (was `sync-login-form` / `SyncLoginForm`)
- `account-settings-cards.tsx` / `AccountSettingsCards`, whose inner card is `CreateAccountCard`
- `password-strength-meter.tsx` / `PasswordStrengthMeter`, prop `password`

`sync-client.ts`, `sync-unlock-card.tsx` and `copy-button.tsx` KEEP their names:
the first two are about sync mechanics, not about holding an account.

**Why:** the split follows [[account-namespace-owns-the-ui-vocabulary]]. A name
a reader sees says "account" and "password"; a name the wire owns says "sync"
and "passphrase".

**How to apply:** `app/lib/e2ee/flows/setup-flow.ts` is a COPIED file
([[e2ee-copied-not-extracted]]) and keeps its upstream export surface,
`syncSetupReducer`, `SyncSetupState`, `initialSyncSetupState`. Only
`validateSyncPassphrase` was renamed, to `validatePassword`, because it is the
one export whose message the UI renders. Do not rename the rest to match the
directory. Its sibling `password-strength.ts` (was `passphrase-strength.ts`)
still exports `ratePassphrase` and `passphraseStrengthKey` for the same reason.
The tests live in `tests/unit/account-ui.test.ts`.
