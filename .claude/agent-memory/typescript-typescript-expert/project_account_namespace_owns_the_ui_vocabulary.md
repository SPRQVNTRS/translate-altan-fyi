---
name: account-namespace-owns-the-ui-vocabulary
description: In translate-altan-fyi the account UI copy lives under account.*, and sync.* keeps only three sync-mechanics keys
metadata:
  type: project
---

Every user-facing string about creating, signing into or managing the account
lives under `account.*` in `app/locales/{en,de}/common.json`. `sync.*` retains
exactly three keys: `pending`, `offline`, `genericError`. `genericError` stayed
under `sync.*` on purpose, because `app/components/account/device-list.tsx`
reads it too.

The vocabulary is fixed: a `handle` is a "sign-in name" (`account.handleLabel`)
and a `passphrase` is a "password" (`account.passwordLabel`). Identifiers,
schemas, HKDF labels and `PROTOCOL.md` keep `handle` and `passphrase`; only the
copy changes.

**Why:** the four-screen "Set up sync" ceremony read as a feature to configure
rather than an account to create, and the operator called it confusing and
bloated. `AGENTS.md` now states the rule.
**How to apply:** never add a new `sync.*` key for anything a signed-out person
reads. A key rename here is invisible to `tsc` (i18n keys are plain strings)
EXCEPT where a test imports `common.json` and dereferences the path, as
`tests/unit/sync-ui.test.ts` does for the strength bands.
Related: [[translate-altan-fyi-verify-commands]].
