---
name: oxlint-anti-slop-patterns
description: How to satisfy the oxlint "anti-slop" JS-plugin rules (openplate-inference, public-release lint pass) without suppressions
metadata:
  type: project
---

The `anti-slop` oxlint JS plugin (`tools/oxlint/anti-slop/`, wired via `jsPlugins` in
`.oxlintrc.json`) is used on SPRQVNTRS TS repos being prepped for public release
(first: `openplate-inference`, 2026-08). Every rule has a clean, non-suppression fix:

- `require-safety-comment-for-type-assertion` — a `// SAFETY: ...` comment on the
  assertion or its **containing statement** (rule walks up to
  ExpressionStatement/VariableDeclaration/Return/Throw/PropertyDefinition). Const
  assertions are exempt.
- `no-runtime-typeof` — bans **every** `typeof` unary, even in guards, unless
  `allowInTypeGuards` is set. Replace with `instanceof` chains, `Array.isArray`,
  `?? fallback`, or a zod parse.
- `no-unknown-parameters` — only fires on a **direct** `: unknown` annotation
  (`Promise<unknown>` params are fine); `cause` is exempt. A `try/catch` binding is
  not a parameter, so `catch (e)` inside a helper is the escape hatch for the
  `.catch((e: unknown) => e) as Error` idiom.
- `no-unsafe-dictionary-type` / `no-known-value-widening` — replace
  `Record<string, any|unknown>` annotations with a named interface; for test
  fixtures reading a request body, `Schema.parse(req.body)` removes the assertion,
  the dictionary and the typeof checks in one move.
- `no-shape-in-symbol-names` — bans the substring "shape" **anywhere**, including
  zod's `schema.shape` member access. `Object.keys(schema.keyof().enum)` is an
  order-preserving zod v4 replacement.

**Why:** these are enforced errors on public repos; suppressing them defeats the point.
**How to apply:** run `toolbox run -c ts-dev env CI=true npx oxlint <dir> --format=github`
for a one-line-per-error list, then fix by rule class. Related: [[translate-altan-fyi-verify-commands]].
