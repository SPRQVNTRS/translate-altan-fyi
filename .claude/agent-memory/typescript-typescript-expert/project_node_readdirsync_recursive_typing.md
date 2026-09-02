---
name: node-readdirsync-recursive-typing
description: readdirSync with { recursive: true } types as (string | Buffer)[] unless encoding is passed
metadata:
  type: project
---

`readdirSync(dir, { recursive: true })` types its result as
`(string | NonSharedBuffer)[]` under this repo's @types/node, so `.endsWith()` and
assignment to `string[]` both fail typecheck. Pass the encoding explicitly:
`readdirSync(dir, { recursive: true, encoding: 'utf8' })` selects the `string[]` overload.

**Why:** the overload is chosen by the options object, not by runtime behaviour.
**How to apply:** any recursive directory walk in this repo; avoids a type assertion,
which the anti-slop lint gate would demand a `// SAFETY:` comment for.
Related: [[oxlint-anti-slop-patterns]].
