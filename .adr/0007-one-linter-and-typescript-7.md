# 0007 — One linter (oxlint), and TypeScript 7

- **Status:** Accepted
- **Date:** 2026-08-16
- **Deciders:** Altan

## Context

[ADR-0005](0005-oxlint-and-anti-slop-are-the-lint-gate.md) made oxlint this
repo's linter, but ESLint stayed behind for one job: the cross-variant
`no-restricted-imports` guardrails that confine Supabase, remix-auth, and
bcryptjs imports to their variant trees.

That leftover was expensive out of proportion to its size. ESLint pulled in
typescript-eslint, and typescript-eslint refuses TypeScript 7
([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)):
8.59.1 crashes outright, 8.67.0 detects the version and errors. The usual escape —
TypeScript 7 for the app, an older TypeScript pinned beside it for the linter —
does not hold, because pnpm resolves typescript-eslint's `typescript` peer from
the root regardless of what is nested. Both `overrides` and `packageExtensions`
were tried.

So the repo briefly pinned TypeScript 6, on the reasoning that dropping ESLint
would trade the variant guardrails for compile speed. That reasoning was wrong.
It assumed the guardrails could only be expressed in ESLint. oxlint implements
`no-restricted-imports` — both the `patterns` and `paths` forms, per-pattern
messages, per-glob `overrides` — and it honors the
`// eslint-disable-next-line no-restricted-imports` suppressions already in the
source. Nothing had to be traded.

## Decision

**oxlint is the only linter, and the repo runs TypeScript 7.**

- ESLint, `@eslint/js`, typescript-eslint, and `eslint.config.js` are removed.
  `pnpm lint` is a single command: `oxlint --max-warnings 0`.
- The variant guardrails live in two `.oxlintrc.json` `overrides` entries: one
  scoping the five variant-only package patterns to `app/`, `cli/`, `drizzle/`
  and the three root entrypoints; one banning `#drizzle/tenant` inside
  `variants/single-tenant/`. That tree was removed from `ignorePatterns` so its
  guardrail can actually fire — it now gets the full gate rather than one rule.
- TypeScript **7.0.2**, the stable `latest` tag. `tsconfig.json` carries no
  `baseUrl` (removed for TypeScript 6, TS5102; `paths` are `./`-relative and
  were unaffected).

**Caveat for anyone editing those globs:** oxlint matches `overrides.files`
against the full path, so a glob must start with `**/`. A bare `app/**/*.ts`
silently matches nothing — it does not error, it just never applies. Every glob
in the config is written `**/app/**/*.ts` for this reason.

## Alternatives Considered

**Keep ESLint for the guardrails and add oxlint's `no-restricted-imports` too.**
Belt and braces. Rejected — two linters enforcing one rule is drift waiting to
happen, and it would not have unblocked TypeScript 7 anyway.

**Keep ESLint, stay on TypeScript 6.** Rejected once the guardrails were shown
to port cleanly: that is a compiler generation and two dependencies paid for a
rule oxlint already has.

**Wait for typescript-eslint to support TypeScript 7.** Rejected as no longer
relevant — with typescript-eslint gone, its release schedule stopped being our
problem.

**Take TypeScript 7.1 (`next`).** Rejected — `7.0.2` is the stable `latest`, and
at 39 days old it clears the repo's 7-day `minimumReleaseAge` supply-chain gate
on its own merits.

## Consequences

**Typecheck is dramatically faster.** `pnpm typecheck` — `react-router typegen`
*and* a full `tsc` — completes in about 2 seconds, on CI and in the edit loop.

**One linter, one config, one command.** `.oxlintrc.json` is the complete
description of what is enforced; there is no second config and no question about
which linter owns a rule.

**No more coupling between the linter and the compiler version.** That coupling
is what forced the brief TypeScript 6 pin in the first place.

**The `// eslint-disable-next-line` comments in source still work** — oxlint
honors them, so the legitimate variant-boundary exceptions in
`app/services/auth.server.ts`, `app/models/users.server.ts`, and
`drizzle/seed.ts` were left alone rather than churned to `oxlint-disable`.

**We give up ESLint's plugin ecosystem.** If a future rule has no oxlint
equivalent and cannot be written as an oxlint JS plugin, reintroducing ESLint
means re-taking the TypeScript-version coupling. Check oxlint's catalog first;
`oxlint --type-aware` also exists for rules that need type information.

**Guardrail parity was verified by planting violations**, not by inspection:
each of the five banned patterns in an in-scope directory, the `#drizzle/tenant`
ban in `variants/single-tenant/`, and negative controls in out-of-scope trees.
All fired and stayed silent as expected.

## References

- [ADR-0005](0005-oxlint-and-anti-slop-are-the-lint-gate.md) — the lint gate itself
- [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) — the blocker that no longer applies to us
