---
name: translate-invite-token-pepper-is-a-third-subkey
description: Invite tokens are hashed with a third SERVER_SECRET subkey derived in app/lib/invites/token.ts, not by extending the copied server-secrets.ts
metadata:
  type: project
---

`invites.token_hash` in translate-altan-fyi holds
`HMAC-SHA-256(inviteTokenPepper, token)`, hex, computed by
`computeInviteTokenHash` in `app/lib/invites/token.ts`, which calls the EXISTING
`computeVerifier` (`app/lib/e2ee/verifier.ts`). There is one keyed-hash primitive
in this repo, not two.

The pepper is a THIRD subkey of the single `SERVER_SECRET`, under the frozen label
`translate-altan-fyi:invite-token-pepper:v1`, derived in that same new module.

**Why it is NOT a new field on `deriveServerSecrets`:** `app/lib/e2ee/server-secrets.ts`
is a copied file (ADR-0008, "do not let the two drift") and the label belongs to a
decision openplate-sync does not have. For the same reason the module lives in
`app/lib/invites/`, outside the copied `app/lib/e2ee/` zone.

**How to apply:** the redemption path (M184 spec 02) must hash a presented token with
`deriveInviteTokenPepper(CONFIG.e2ee.serverSecret)` and compare with
`inviteTokenHashMatches`, and must run `isSignupInviteToken` as the pre-lookup shape
gate. Rotating `SERVER_SECRET` now also invalidates every unredeemed invite.
Related: [[e2ee-is-copied-not-extracted]].
