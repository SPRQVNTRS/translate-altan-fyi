---
name: translate-attribution-generated-source-slug
description: attribution.tsx's slug-vs-licence classification lives as isGeneratedSource in generated-source.ts, unit-tested with no DB
metadata:
  type: project
---

`app/routes/attribution.tsx` finds the generated dictionary source by
`source.slug === GENERATED_SOURCE_SLUG` ('llm-generated'), never by licence —
the row now carries `CC0-1.0` like imported sources, so a licence-keyed check
silently stops matching. The decision is extracted as
`isGeneratedSource(source: { slug: string }): boolean` in
`app/lib/dictionary/generated-source.ts` (not in attribution.tsx itself),
because attribution.tsx imports `#drizzle/db` (`getRawDb`), and importing that
module opens a real `pg.Pool` at module-eval time (see `drizzle/db.ts`) — so a
unit test importing attribution.tsx directly would not be DB-free. Test:
`tests/unit/attribution-generated-source.test.ts`.

**Why:** M193 counsel adjustment M required a no-DB unit test per the spec at
`.tracker/M193-trl-llm-translations-on-demand/01-the-job-the-corpus-rows-and-their-provenance.md`.

**How to apply:** when a route file imports `#drizzle/db` (directly or
transitively) and you need a DB-free unit test of one of its pure decisions,
extract that decision into whatever shared lib module the route already
imports for a DB-free reason (here, `generated-source.ts`, which explicitly
bans imports) rather than into the route file itself.
