# 0005 — oxlint + anti-slop is the lint gate

- **Status:** Accepted
- **Date:** 2026-08-16
- **Deciders:** Altan

## Context

This codebase is written largely by LLM agents, and LLM-written TypeScript fails
in a characteristic way: it *type-checks* while carrying no evidence. `unknown`
parameters, `typeof` chains standing in for a parsed contract,
`as unknown as Foo` to silence a mismatch, `Record<string, unknown>` as a
universal payload type. None of that is caught by `tsc` — every one of those
patterns is well-typed. It is caught, eventually, by a human reading a diff, or
by production.

Before this decision the repo had no defense. ESLint — since removed, per
[ADR-0007](0007-one-linter-and-typescript-7.md) — was configured with exactly one
rule family, `no-restricted-imports`, guarding the cross-variant boundaries, and
no correctness, unused-code, or style rules at all. There was no CI beyond
the Claude review bots, so nothing ran automatically on a push. The only gate was
`pnpm lint` typed by hand, and it checked almost nothing.

[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) is a set of 15 oxlint
rules built for exactly this failure mode. They are deliberately blunt: they
reject the *shape* of low-evidence code rather than trying to prove it wrong.
`no-runtime-typeof` bans `typeof` outright, on the grounds that a `typeof` check
narrows a representation without establishing a contract. That bluntness is the
point — a rule an agent can argue its way around is not a gate.

## Decision

**oxlint is this repo's linter**, and it runs all 15 anti-slop rules at `error`.

Concretely:

- Configuration lives in `.oxlintrc.json` — oxlint's *default* config path. A
  bare `oxlint`, the editor extension, `--fix`, and any ad-hoc run all pick up
  the full gate with no flags. There is no second, weaker configuration to
  accidentally run.
- The gate is oxlint's own `correctness`/`suspicious`/`perf` catalog (plus the
  typescript, react, import, promise, node, unicorn, oxc, and jsx-a11y plugins)
  **and** anti-slop, in one pass.
- anti-slop is **vendored** under `tools/oxlint/anti-slop/` — upstream's `src/`
  copied verbatim from <https://github.com/dmmulroy/anti-slop> at commit
  `446268e` (MIT), loaded via `jsPlugins`. Upstream's package is `private` and
  unpublished — it ships to be vendored rather than depended on — and vendoring
  also means a rule cannot change underneath us on an install. Provenance and
  the drift check live in `tools/oxlint/README.md`.
- oxlint is the *only* linter. The cross-variant `no-restricted-imports`
  guardrails live in `.oxlintrc.json` `overrides` — see
  [ADR-0007](0007-one-linter-and-typescript-7.md).
- **A finding is fixed in the code. A rule is never downgraded to clear one.**
- The gate runs on four surfaces, not on request: the editor (on type, fix on
  save), the Claude Code edit loop (a PostToolUse hook blocks with the
  diagnostic), the pre-commit hook (staged files, installed by the `prepare`
  script), and CI (full tree, on every PR and push to `main`).

Seven of oxlint's built-in rules are `off`. Each is inapplicable to this stack
rather than inconvenient, and each has its reason recorded in the rationale table
in [AGENTS.md](../AGENTS.md#rules-deliberately-disabled). The one that matters
most: `unicorn/no-instanceof-builtins` demands the `typeof x === 'function'`
check that `anti-slop/no-runtime-typeof` bans, so `instanceof Function` is the
callable test the stricter gate leaves open.

## Alternatives Considered

**Run anti-slop at `warn`.** The usual way to adopt a strict ruleset without a
big-bang cleanup. Rejected: a warning in a codebase written by agents is a
warning nobody reads. The findings would have accumulated rather than been paid
down, and the 379 initial findings would still be there.

**Enable `allowInTypeGuards` on `no-runtime-typeof`.** The rule offers this
option, and it would have cleared a large fraction of findings at a stroke by
exempting any `typeof` inside a user-defined type guard. Rejected: a hand-written
type guard is precisely the unverified-contract pattern the rule exists to
eliminate — `x is Foo` is an assertion, not a proof. Taking the option would have
kept the shape and lost the point.

**typescript-eslint's type-aware rules instead.** `no-unsafe-assignment`,
`no-unsafe-member-access` and friends cover adjacent ground with real type
information. Rejected as the primary gate on speed: type-aware linting is
seconds-to-minutes on this tree, which is too slow for an on-type editor lint or
a pre-commit hook, and a gate that only runs in CI is a gate agents discover
after the fact. It also does not cover the specific shapes anti-slop targets
(`Record<string, unknown>` payloads, chained assertions, `unknown` returns).

**Consume anti-slop as an npm dependency.** Rejected because upstream does not
publish it as one — it is distributed to be copied.

## Consequences

**The boundary architecture is now load-bearing, not stylistic.** Because
`no-runtime-typeof` and `no-unknown-parameters` leave no other way to handle an
external value, every I/O boundary must decode into a named domain type. That is
why `cli/lib/schemas.ts` (drizzle-zod row schemas), the schema-per-call
`transport.get(path, schema, params)`, `parseJsonBody(request, schema)`, and
`workflowOrgId(context)` exist in the shapes they do. Removing this ADR would
not just relax a linter; it would strand that architecture without its
justification.

**Fixing the initial 379 findings surfaced seven latent bugs**, including a
connection-pool poisoning in `db query` (a session-level `SET TRANSACTION READ
ONLY` leaking onto a pooled connection and breaking later writers) and three
route handlers returning a `{rows,total}` envelope where callers expected an
array. The schema-parsed transport is what turned those from silent
misbehaviour into loud failures.

**New code has to earn its types.** An agent that reaches for `unknown` or a
`typeof` check gets blocked at edit time with the rule text. This is the intended
cost: writing a schema at the boundary takes longer than writing a type guard.

**Where TypeScript genuinely cannot express an invariant, the assertion stays** —
with a `// SAFETY:` comment stating what makes it sound. Drizzle's generic
erasure, CSS custom properties, and cross-package type identity are the real
cases in this repo. `require-safety-comment-for-type-assertion` enforces that the
note exists; it cannot enforce that the note is true, so that remains a
code-review responsibility.

**Vendored code drifts.** `tools/oxlint/anti-slop/` will not pick up upstream
fixes or new rules on its own. Re-vendoring is a deliberate act, and the tree
should be diffed against upstream `src/` when it happens.

**The full-tree gate is a pre-push hook, not cloud CI** (`.githooks/pre-push`:
lint → typecheck → unit tests → content validation → build). A GitHub Actions
workflow held this role from 2026-08-16 and was removed on 2026-08-31: its
`pnpm install` could not resolve the private `@sprqvntrs/*` scope, because those
packages belong to `SPRQVNTRS/platform` and a job-scoped `GITHUB_TOKEN` cannot
read another repository's packages. The hook has no such problem — it resolves
the scope from the developer's `~/.npmrc`. This also aligns the repo with the
workspace policy that a green push IS the signal.

The auth obstacle itself was later removed — a `PACKAGES_TOKEN` secret was added
on 2026-08-31 — but the decision stands on the policy, not on the obstacle, so
the gate stays local. The secret is unused and parked for any future workflow.

## References

- [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) — upstream source (MIT)
- `tools/oxlint/README.md` — vendoring provenance, pinned commit, drift check
- [oxlint](https://oxc.rs/docs/guide/usage/linter.html)
- `AGENTS.md` § Linting — rule-by-rule guidance and the disabled-rule rationale
- [ADR-0007](0007-one-linter-and-typescript-7.md) — oxlint as the sole linter, and TypeScript 7
- PR #10
