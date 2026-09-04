---
name: the-tenancy-is-gone-adr-0010
description: M189 deleted the inherited org/users/CMS surface; no tenantDb, no users row, root.tsx returns no user
metadata:
  type: project
---

The `ts-factory-stack` tenancy was deleted by M189, recorded in
`.adr/0010-drop-the-inherited-tenancy.md`, which supersedes ADR-0003.

**Why:** `organizations`, `organizationMembers` and `users` all held zero rows
in production and no product path reached any of them. `api.v1.metric-events`
had no writer anywhere.

**How to apply:**
- There is no `tenantDb`, no `orgId` and no `users` row. A model reads `db`
  directly. `apiKeys` carries its own `isSuperadmin`.
- `root.tsx`'s loader no longer returns `user`; `app/hooks/use-user.ts` is gone.
  Read the account through `getAccount(context)` on the server.
- `app/cms/` and the `content:validate` script and pre-push tier are gone. The
  registry was empty, so the tier measured nothing. `gray-matter`, `markdown-it`
  and `yaml` are still in `package.json` and are now unused.
- `app_settings_audit.actorEmail` holds an account HANDLE now, because this
  service holds no email address for anybody. The column keeps its old name.
- The `unrouted` category in `app/lib/route-classification.ts` has no member
  left. Keep it: the next inherited leftover has to be classifiable.
