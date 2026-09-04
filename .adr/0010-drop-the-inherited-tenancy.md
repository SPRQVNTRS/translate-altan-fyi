# 0010: Drop the inherited tenancy, org and CMS surfaces

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** operator

## Context

This repository was cloned from `ts-factory-stack`, by way of `openplate`. The
starter ships a full business-application skeleton: organizations, memberships,
roles, a user table with an admin screen for it, a tenant-scoped query wrapper,
a small file-backed CMS, and a REST surface over all of it. None of that was
written for this product. It arrived with the clone and it has been carried,
migrated and typechecked ever since.

This product is a vocabulary and translation tool for one reader at a time.
A person signs up with a handle and a password, and their lists, history and
notes are encrypted in their own browser (ADR-0008, ADR-0009). There is no
second party to isolate them from. The only shared thing on the server is the
dictionary cache, which is deliberately global.

An audit before this decision looked for a caller, in the app, in the CLI, in
the tests and in the production database. The result:

**Dead, no caller and no rows.**

| Surface | Finding |
|---------|---------|
| `/dashboard`, `/select-org`, `/create-org` | Starter screens. No link into them from any product screen. |
| `/org/:slug/{dashboard,profile,settings,workflows,users,users/invite}` | The whole org tree. Unreachable without an organization, and there are none. |
| `/super/orgs`, `/super/users` | Operator views over the two empty tables. |
| `api.v1.users*`, `api.v1.orgs*` | Three route files each. Superadmin-only, no client. |
| `api.v1.data-sources` | No product path writes or reads a data source. |
| `api.v1.metric-events` | **No writer existed anywhere.** The endpoint reported a table nothing ever inserted into. |
| `api.v1.workflows*` | Seven route files. The CLI reads workflows through its own path. |
| `organizations`, `organizationMembers` | Zero rows in production. |
| `users` | Zero rows in production. `createUser` had no caller outside the seed. |
| `articles`, `categories`, `pages` | Tenant-scoped content tables with no model files at all. |
| `metricEvents`, `dataSources` | Zero rows. |
| `authMiddleware` | Required an account AND a linked `users` row, so it could never admit anybody. |
| `tenantDb` | The wrapper. Every table it scoped is on this list. |
| `app/cms` | An empty registry. `content:validate` walked zero collections and passed. |
| `nav-user.tsx` | A component nothing imported. |
| CLI `organization`, `user`, `data-source`, `metric-event`, `workflow` | Command groups over the above. |

**Live, and staying.**

| Surface | Why |
|---------|-----|
| `/super/llm` | Edits `app_settings`, which enrichment reads on every call. |
| `/super/whoami-ip` | Checks the `TRUST_PROXY` hop count against a live proxy. |
| `api.v1.admin.db.*` | The five DB health and inspection endpoints the CLI uses. |
| `apiKeys` | The bearer-token surface still authenticates the CLI. |
| `dataMigrations` | The runner from ADR-0002. |
| `workflows` tables | 15 live enrichment rows. The tables outlived their REST surface. |

Carrying dead scaffolding is not free. It is the largest single source of
"which of these do I use" in the repository, `tenantDb` puts a tenancy rule in
front of every new table a contributor adds, and ADR-0003's warning about
external SQL writers reads as a live constraint on a schema that has no tenants.

## Decision

Delete the inherited multi-tenancy and everything that existed only to serve it.

Specifically:

1. **Eight tables go**: `organizations`, `organizationMembers`, `users`,
   `articles`, `categories`, `pages`, `metricEvents`, `dataSources`.
2. **The screens go**: `/dashboard`, `/select-org`, `/create-org`, the whole
   `/org/:orgSlug/*` tree including its user management, and `/super/orgs` and
   `/super/users`.
3. **The REST endpoints go**: `api.v1.users*`, `api.v1.orgs*`,
   `api.v1.data-sources`, `api.v1.metric-events`, and all seven
   `api.v1.workflows*` files.
4. **`authMiddleware` and `tenantDb` go.** `accountMiddleware` gates the app
   screens and `superadminMiddleware` gates the operator ones, both over the
   account session alone.
5. **`apiKeys` is reworked to stand alone**, with an `isSuperadmin` flag on the
   key instead of a join through a user row to an organization. A key is either
   an ordinary key or a superadmin key, and it belongs to nobody but the
   instance.
6. **`/super/` keeps two screens**, `llm` and `whoami-ip`. A bare `/super`
   redirects to `/super/llm`.
7. **`app/cms` goes**, with the `content:validate` script and its tier in the
   pre-push gate. It validated an empty registry, so the tier was a green light
   that measured nothing.
8. **`admin/db/*` and the data-migration runner stay** exactly as they are.

ADR-0003 is superseded by this record.

## Alternatives Considered

- **Keep it, in case the product grows a team feature.** The cost is paid every
  day and the benefit is hypothetical. A tenancy model added later, for a real
  requirement, would not look like this one anyway: it would be built around
  `accounts`, which is where authentication actually lives.
- **Keep the tables, drop only the screens.** This is the worst of both. The
  migrations, the types and the `tenantDb` rule all survive, and the audit
  above gets harder next time because the evidence of disuse is gone.
- **Keep `users` as the org half of an account.** `users.accountId` was the
  join, and it was never populated. Superadmin already moved to
  `accounts.is_superadmin`, so the row carried nothing that was read.

## Consequences

- The schema drops from the starter's shape to this product's shape. A new
  table needs no tenancy decision, because there is no tenant.
- `getRawDb()` has no counterpart left to be loud about. The name survives its
  purpose and should be simplified when something else touches it.
- The bearer-token API surface shrinks to api keys and DB admin. Any client
  that called the deleted endpoints breaks, which is a group with no members:
  the CLI is the only client and it is changed in the same milestone.
- The pre-push gate loses a tier and gets faster. It loses nothing it was
  checking, because the CMS registry it validated was empty.
- The org audit columns on `app_settings_audit` keep their inherited names.
  `actorEmail` now carries an account handle, because this service holds no
  email address for anybody. Renaming those columns is follow-on work.
- `gray-matter`, `markdown-it` and `yaml` become unused dependencies once
  `app/cms` is gone. Removing them is follow-on work, because it touches the
  lockfile.
- Anyone reading `ts-factory-stack` alongside this repository will find the two
  much further apart. That is the intended outcome: this is a product now, not
  a clone of a starter.

## References

- [ADR-0003](0003-app-enforced-multi-tenancy.md), superseded by this record.
- [ADR-0002](0002-data-migrations.md), the runner that stays.
- [ADR-0008](0008-e2ee-sync-copied-not-extracted.md), why the account layer is
  copied rather than shared.
- [ADR-0009](0009-invite-only-accounts.md), the account model that replaced the
  inherited one.
- `app/lib/route-classification.ts`, the manifest of what is left under
  `app/routes/`.
