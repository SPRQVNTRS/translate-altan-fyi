---
name: project_enrichment_trigger_is_the_shared_seam
description: Both the entry route and search.tsx get their enrichment panel from app/lib/enrichment/trigger.server.ts, and a tracker grep demands the two files import the SAME enrichment module paths.
metadata:
  type: project
---

`app/lib/enrichment/trigger.server.ts` holds `resolveTriggeredPanel`, the one
machine that reads the cache (`resolveEnrichmentPanel`), runs the two spend
guards, and enqueues behind the response. `entry.$headwordId.tsx` and
`search.tsx` both call it and both render `EnrichmentSection`. The poll route
`api.enrichment.$headwordId.ts` deliberately does NOT import it: it must never
enqueue.

**Why:** M185/03 put the top hit's panel inline in the search output pane. A
second copy of the refusal-folding rules is how the two surfaces would come to
show a skeleton on one screen and a refusal line on the other for the same word.

**How to apply:** M185/03's checklist diffs the sorted `#app/...enrichment...`
import lines of the two route files and demands they be IDENTICAL. The regex
also catches `#app/components/enrichment-section` and
`#app/prompts/enrichment/version`, so adding a PROMPT_VERSION import to one
route alone turns that check red. Keep the set at exactly
`enrichment-section` plus `lib/enrichment/trigger.`

Related: [[project_ts_union_member_with_two_literal_states]]
