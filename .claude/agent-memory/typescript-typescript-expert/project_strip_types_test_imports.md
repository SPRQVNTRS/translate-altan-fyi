---
name: strip-types-test-imports
description: a test run by bare `node --experimental-strip-types` cannot use the `#app/*` aliases and needs a literal `.ts` extension, which costs one tsconfig flag
metadata:
  type: project
---

`tests/unit/auth/*.test.ts` are run BOTH by `pnpm test:unit` (through tsx) and
by a bare `node --experimental-strip-types --no-warnings --test`, which is what
M191's own verification checklist calls.

Strip-only Node resolves NEITHER the `#app/*` path aliases (package.json has no
`imports` field, they are tsconfig `paths` that only a bundler or tsx reads) NOR
an extensionless relative specifier. So those files import
`../../../app/lib/auth/tokens.ts` with the extension written out, and
`allowImportingTsExtensions: true` is in tsconfig so `tsc` accepts that form.
It is safe because `noEmit` is on.

**A type-only import survives.** `app/lib/auth/tokens.ts` imports
`UserTokenKind` from `#drizzle/schema` with `import type`, which is erased
before resolution, so the alias never has to resolve.

**The checklist's `grep -E "^# (pass|fail)"` needs `--test-reporter=tap`.**
Node 24's default spec reporter prints `ℹ pass N`, not `# pass N`.

**Why:** the tier is worth keeping pure. Anything reaching `#drizzle/tenant-db`
or `drizzle/db.ts` connects at import and hangs for a minute with no database.

Related: [[project_verify_commands]], [[project_integration_self_skip_guard]].
