---
name: ts-union-member-with-two-literal-states
description: A discriminated-union member whose discriminant is itself a two-literal union is never removed by exhaustive narrowing; give each state its own member
metadata:
  type: project
---

A union member declared as `{ state: 'pending' | 'ready'; ... }` narrows its own
`state` property when you test it, but TypeScript never REMOVES the member from
the union. So after `if (s.state === 'ready') return;` and
`if (s.state === 'pending') return;`, the remainder still contains that member,
and reading a field the other member types differently fails with TS2322.

**Why:** hit in `app/lib/enrichment/state.server.ts` on translate-altan-fyi. An
`EnrichmentPanelIdle | EnrichmentPanelWorking` pair, where Working carried
`state: 'pending' | 'ready'` and `reason: null`, made `panel.reason` read as
`EnrichmentIdleReason | null` in the branch that had already excluded both
working states.

**How to apply:** when a union is meant to be exhausted by `state` checks, give
every member exactly ONE literal discriminant. Share the common fields through a
non-exported base interface and `extends` it once per state. Cheap, and it makes
the narrowing work everywhere instead of only in the ready branch.
