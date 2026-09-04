---
name: sync-session-is-installed-from-root-data
description: nothing called setSyncSession after M191/01, so sync never ran; _app.tsx now installs it from root's userId
metadata:
  type: project
---

`root.tsx`'s loader returns `userId` beside `userEmail` (from
`readUserForDisplay`, which returns `{ id, email } | null`), and `_app.tsx` has
an effect keyed on that id that calls `setSyncSession({ userId })` or
`clearSyncSession()`.

**Why:** before M191 a sync session existed only as long as the in-memory data
key, so a reload lost it. After the key was removed nothing installed one at
all: `getSyncSession()` was permanently `null`, every scheduler trigger returned
early, and a device with a full local store synced nothing. Lint, typecheck,
573 unit tests and 87 integration tests were all green.

**How to apply:** the id is NOT a credential, and the comment on
`readUserForDisplay` says so: every request is authorised by the httpOnly
cookie. The effect skips a re-install when the id is unchanged, because every
clientAction revalidates root (see [[project_root_clientloader_offline_revalidation]])
and `setSyncSession` notifies the scheduler.
