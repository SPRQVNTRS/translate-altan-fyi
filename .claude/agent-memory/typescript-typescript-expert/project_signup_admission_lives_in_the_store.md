---
name: signup-admission-lives-in-the-store
description: The invite gate is a field on CreateAccountInput enforced inside the account-insert transaction, not a check in handleSignup; signupMode 'invite' is a hardcoded literal and 'open' is refused
metadata:
  type: project
---

Signup admission (invite or bootstrap token) is `CreateAccountInput.admission`,
a required discriminated union enforced INSIDE `createAccount`'s transaction in
`app/lib/e2ee/drizzle-account-store.server.ts`. `handleSignup` only classifies
WHICH admission was presented; it never asks whether it is spendable.

**Why:** a check in the handler, before the transaction opens, is a
read-then-write race, and two holders of one invite would both be admitted.
ADR-0009 rejected its Option A over exactly that window. The union has no
"no admission needed" member on purpose, so an ungated signup cannot be one
forgotten argument away.

**How to apply:**
- Admission is claimed BEFORE the account insert, so an uninvited caller never
  reaches the `409` handle-taken oracle. Do not reorder; the narrowing is a
  security property.
- A refusal after the claim must travel as a THROW (`AccountCreationRefused`),
  never a `return`: returning from a drizzle transaction callback COMMITS, and
  what is already written is a spent invite. The rollback is what keeps a
  handle collision from burning somebody's invitation.
- The plaintext token never crosses the store port. `AuthContext.admission`
  (`SignupAdmissionPort`) injects `hashInviteToken` and `isBootstrapToken`, so
  the copied `auth-handlers.ts` needs no import of `app/lib/invites/token.ts`
  and the unit suite needs no server secret.
- `signupMode` is a hardcoded `'invite'` literal in `e2ee-context.server.ts`.
  `handleSignup` refuses anything that is not `'invite'`, INCLUDING `'open'`.
  There is no env var that can reopen signup.
- Every refusal is one `403` with the single `SIGNUP_NOT_ADMITTED` string, which
  names all four causes at once so it is evidence for none of them.

Related: [[bootstrap-zero-account-check-needs-an-advisory-lock]],
[[project_invite_token_pepper_is_a_third_subkey]].
