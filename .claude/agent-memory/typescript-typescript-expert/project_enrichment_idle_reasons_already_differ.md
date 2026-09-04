---
name: project_enrichment_idle_reasons_already_differ
description: The two idle reasons, not-configured and not-requested, already render DIFFERENT sentences in EnrichmentSection, so a healthy provider key no longer reads like a dead one.
metadata:
  type: project
---

`IdlePanel` in `app/components/enrichment-section.tsx` picks
`enrichment.notConfigured` for `reason === 'not-configured'` and
`enrichment.idle` otherwise. Both strings exist in `app/locales/en/common.json`
and `app/locales/de/common.json`. Verified 2026-09-03.

**Why:** the ambiguity is remembered as a live trap ("a healthy API key looked
dead"), and it was fixed at the component, not at the resolver: the resolver
still returns `state: 'idle'` for both cases on purpose, because they are one
state with two reasons.

**How to apply:** any NEW surface showing panel states must render through
`EnrichmentSection` rather than writing its own idle line. Writing a second idle
sentence is how the ambiguity comes back. Note the residual case nobody has
copy for: a headword with zero senses also reports `not-requested`, so it
promises notes that will never be asked for.

Related: [[project_enrichment_trigger_is_the_shared_seam]]
