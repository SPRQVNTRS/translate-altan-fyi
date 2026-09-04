# M191 browser walk — 2026-09-04

Dev commit: `0397a1d` with uncommitted M191/03 changes (account rewrite: email +
password accounts, verification/reset mail printed to the server console,
plain JSON sync blob per user).

Test account: `walk-1788526215@example.com` / password chain
`correct horse battery` → `battery staple horse correct` → `horse staple correct battery`.

## Results

| Step | Result | Evidence |
|---|---|---|
| 1. Home, anonymous | PASS | Hero with "Create account"/"Sign in", example translation for "Haus" in the output pane. `/tmp/trl-walk-01-home.png` |
| 2. `/sign-up` centering | **FAIL** | Card center x = 768px, viewport center x = 640px (128px off, tolerance is 40px). The sidebar (full nav, open by default even for an anonymous visitor) occupies 256px on the left, so the card is centered in the *content* column, not the viewport. Screenshot `/tmp/trl-walk-02-signup.png` shows the card pushed well right of center. |
| 2. `/sign-up` submit → inbox screen | PASS | "Check your inbox" heading + "Send the link again" resend button. `/tmp/trl-walk-03-inbox.png` |
| 3. Re-submit `/sign-up`, same email | PASS | Identical "Check your inbox" screen, no "already exists" leak. |
| 4. Sign in before verification | **FAIL** (wording) | Does not sign in (correct), but the alert reads "Address and password do not match a confirmed account." — not the "confirm your email first" line the spec calls for. A "Send the link again" link is present, but it's a static link on the page at all times, not a resend form that appears specifically for this case. `/tmp/trl-walk-04b-signin-unverified.png` |
| 5. Open verification link | PASS | "Address confirmed" heading with a "Sign in" link. |
| 5. Re-open same verification link | PASS | "This link no longer works" with a resend form. |
| 6. Sign in, land on `/` | PASS | Landed on `/`, header shows `Account walk-1788526215@example.com`. `/tmp/trl-walk-04-signed-in.png` |
| 7. Search "Haus", open entry, add to list, check sync_blobs | PASS | Saved to new list "Walk Test List" (toast "Saved to Walk Test List"). After 5s, `sync_blobs` has one row for user 293, `blob_version = 2`, payload length 989. |
| 8. New context, sign in, `/lists` shows the list | PASS (needed extra wait) | First load right after sign-in showed "No lists yet"; the list appeared only after an extra ~5s wait and reload — sync is not instant on a fresh device, worth noting even though it eventually passed. `/tmp/trl-walk-05-second-device.png` (390×844) |
| 9. `/account` password change stays signed in | PASS | URL became `/account?changed=1`, page still shows the signed-in account and the change-password form. |
| 9. First context `/lists` after password change | PASS | Redirected to `/sign-in?next=%2Flists` — old session invalidated. |
| 10. `/forgot-password` generic line | PASS | "Check your inbox" heading (no account-exists disclosure). |
| 10. Reset link → new password → lands signed in on `/account` | PASS | Landed directly on `/account` after reset. |
| 10. Sign out → `/`, header shows "Sign in" | PASS | Landed on `/`, header shows "Sign in". |
| 10. `/lists` after sign-out redirects | PASS | Redirected to `/sign-in?next=%2Flists`. |
| 10. IndexedDB cleared after sign-out | **FAIL** | `indexedDB.databases()` still lists `translate-outbox` and `translate-primary` after sign-out. Sign-out does not drop the local IndexedDB stores. |
| 11. Sign in with newest password works | PASS | Signed in, redirected to `/lists` (preserved `next` param from an earlier redirect). |
| 11. Sign in with old password fails, generic line | PASS | Same "Address and password do not match a confirmed account." alert. |
| 12. `/super/llm` as non-superadmin | PASS | 404 page. |
| 12. Grant superadmin via CLI, reload | PASS | CLI reported "Superadmin privileges granted to account 293". `/super/llm` then returned 200 with the "Language model" admin page. |
| 13. Delete account (password required) | PASS | Landed on `/` signed out after deletion. |
| 13. Sign in after deletion fails | PASS | Same "do not match a confirmed account" alert. |
| 13. psql: zero rows in users/sync_blobs | PASS | `select count(*) from users where email = ...` → 0; `select count(*) from sync_blobs where user_id = 293` → 0. |
| 14. Console errors | PASS (no `[error]` entries) | No `console.error` in either context (HMR/Vite lines ignored). Context 1 logged repeated `[warning]` entries: `local-store: IndexedDB persister load/save error ... "translate-outbox", error: "Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found."` — worth a look, not a hard console error. |
| 15. German via `translate-language` cookie | PASS | Setting the `translate-language=de` cookie and loading `/sign-up` rendered the German UI ("Konto erstellen", "Mailadresse", "Passwort", …). `/tmp/trl-walk-06-signup-de.png` |

## Screenshots

- `/tmp/trl-walk-01-home.png` — anonymous home, 1280×900
- `/tmp/trl-walk-02-signup.png` — sign-up form, off-center (see step 2 FAIL)
- `/tmp/trl-walk-03-inbox.png` — "check your inbox" after sign-up
- `/tmp/trl-walk-04b-signin-unverified.png` — sign-in attempt before verification
- `/tmp/trl-walk-04c-verified.png` — "address confirmed" screen
- `/tmp/trl-walk-04-signed-in.png` — signed-in home, header shows the email
- `/tmp/trl-walk-05-second-device.png` — `/lists` on a second context, mobile viewport 390×844
- `/tmp/trl-walk-06-signup-de.png` — German sign-up form, 1280×900

## Failures — do not paper over

1. **Sign-up card is not centered on the viewport (step 2).** The card's
   horizontal center sits at x=768 against a viewport center of x=640, a
   128px offset — over 3× the 40px tolerance. Root cause: the anonymous
   sidebar (full nav column, 256px wide) stays open on the auth pages, and
   the card centers within the remaining content column instead of the full
   viewport.
2. **Unverified sign-in shows the wrong message (step 4).** The alert text is
   "Address and password do not match a confirmed account." — a message that
   conflates "wrong password" with "not yet confirmed" rather than the
   distinct "confirm your email first" guidance the flow is supposed to give.
3. **Sign-out does not clear local IndexedDB (step 10).** After signing out,
   `indexedDB.databases()` still reports `translate-primary` and
   `translate-outbox`. The next signed-out visitor's browser still carries
   the previous account's local sync stores.

## Cleanup

Dev server (pid 1989545, port 3210) and both browser sessions
(`trlwalk-069c842f74ed`, `trlwalk2-1788526364`) were stopped at the end of
the walk.

## Re-walk — 2026-09-04

Re-ran only the three FAILs from the first pass, against the same commit
(`0397a1d`, working tree unchanged since — the fixes are uncommitted). Fresh
dev server (pid 2348216, port 3210), fresh browser context
(`trlrewalk-069c842f74ed`). Test account:
`walk-1788527609@example.com` / `correct horse battery`.

| Check | Result | Evidence |
|---|---|---|
| A. `/sign-up` sidebar count | PASS | `[data-slot="sidebar"]` count = 0 |
| A. `/sign-up` card centering | PASS | card center x = 640, viewport center x = 640 (exact) |
| A. `/sign-in` sidebar count + centering | PASS | count = 0, card center x = 640 |
| A. `/forgot-password` sidebar count + centering | PASS | count = 0, card center x = 640 |
| A. `/account` still has the sidebar | PASS | `[data-slot="sidebar"]` count = 1 while signed in |
| B. Sign in with correct password, unverified | PASS | Title "Confirm your email address", body "Your password is correct. Click the link we emailed you, then sign in. Request another link below.", "Send the link again" button present |
| B. Sign in with wrong password, same unverified address | PASS | Only the generic line: "Address and password do not match a confirmed account." — no password-correctness detail leaked |
| B. Verify via log link, then sign in | PASS | "Address confirmed" → signed in, landed on `/` with the account header and the full app sidebar back |
| C. Add word to list while signed in | PASS | Saved "Haus" to new list "Rewalk Test List" from the entry page |
| C. IndexedDB after sign-out (3s wait) | **FAIL (partial fix)** | `translate-outbox` is now gone, but `indexedDB.databases()` still lists `translate-primary` |
| C. IndexedDB after reload + 3s more wait | **FAIL** | Still lists `translate-primary` only — confirms a background poll re-creates/keeps it, exactly as the coordinator suspected |
| C. Sign back in, `/lists` shows the word | PASS | "Rewalk Test List" is present after signing back in — it came back from the server, not from the stale local store |
| D. Console errors | **FAIL surfaced** | One real `[error]`, timed right at sign-out: `local-store: locked autosave failed {dbName: "translate-primary", error: "Cannot read properties of undefined (reading 'splice')"}` — this looks like the mechanism behind the leftover `translate-primary` database: an autosave throws mid-teardown and the store never gets torn down cleanly. No `[error]` entries during test A or B. |

### Verdict

- **A (centering) — FIXED.** Sidebar is gone on all three auth screens, cards
  are pixel-exact centered, `/account` keeps its sidebar. Full PASS.
- **B (unverified-sign-in message) — FIXED.** Correct-password/unverified now
  gets the specific "Your password is correct..." guidance; wrong-password
  still gets only the generic line. Full PASS.
- **C (IndexedDB on sign-out) — STILL FAILING, partially improved.**
  `translate-outbox` is now cleared, but `translate-primary` is not: it is
  still present immediately after sign-out, still present after a reload and
  a further 3s wait, and a genuine console `[error]` — "locked autosave
  failed ... Cannot read properties of undefined (reading 'splice')" — fires
  at the same moment, which is very likely why the teardown is failing to
  finish. Sign-in afterward still round-trips correctly through the server
  (the list shows up), so this is a client-side cleanup bug, not a data-loss
  bug — but it is not fixed.

### Cleanup

Dev server (pid 2348216, port 3210) and the browser session
(`trlrewalk-069c842f74ed`) were stopped at the end of the re-walk. Test user
`walk-1788527609@example.com` (id 341) and all other `walk-%@example.com`
rows were deleted from `users` (cascade removed any `sync_blobs`/`user_tokens`
rows).

## Re-walk 2 — 2026-09-04

Re-ran only check C (IndexedDB on sign-out), against the same commit
(`0397a1d`, working tree unchanged since — the fix is uncommitted). Fresh dev
server (pid 2564575, port 3210), fresh browser context
(`trlrewalk2-1788528512`). Test account:
`walk-1788528512@example.com` / `correct horse battery`, list "Rewalk2 Test List".

| Check | `indexedDB.databases()` names | Result |
|---|---|---|
| 1. Right after sign-out (button), landed on `/`, 3s wait | `[]` | PASS |
| 2. Reload `/`, 3s further wait | `[]` | PASS |
| 3. Open `/account`, then `/lists` (redirected to `/sign-in?next=%2Flists`) while signed out, check again | `[]` | PASS |
| Sign back in, `/lists` shows the saved word | "Rewalk2 Test List" present | PASS |
| Console errors (HMR ignored) | none — no `[error]` entries; the earlier `local-store: locked autosave failed ... translate-primary ... reading 'splice'` error did not recur | PASS |

### Verdict

**C is now fully fixed.** Neither `translate-primary` nor `translate-outbox`
appears in any of the three checks — immediately after sign-out, after a
reload plus a further wait, or after visiting `/account` and `/lists` while
signed out. The autosave `[error]` seen in the previous re-walk did not
reproduce. Signing back in still round-trips correctly through the server:
the list created before sign-out reappears in `/lists`.

### Cleanup

Dev server (pid 2564575, port 3210) and the browser session
(`trlrewalk2-1788528512`) were stopped at the end of this re-walk. Test user
`walk-1788528512@example.com` (id 388) and all other `walk-%@example.com`
rows were deleted from `users`.
