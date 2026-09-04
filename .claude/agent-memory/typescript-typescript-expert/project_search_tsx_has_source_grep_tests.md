---
name: project_search_tsx_has_source_grep_tests
description: tests/unit/phrase-branch-routes-to-search-phrase.test.ts greps search.tsx's own SOURCE for call literals, so changing a seam in that loader fails a unit test that is about intent, not the seam.
metadata:
  type: project
---

That unit test reads `app/routes/search.tsx` as text and matches literals like
`normalizeQuery(q, direction.from)`, `searchPhrase(`, `const hits = await
searchHeadwords(`, and (until M185/03) `enqueueEnrichmentInBackground(`.

**Why:** the loader's branch decisions are cheap to assert as source and
expensive to assert as behaviour. The cost is that a legitimate refactor reads
as a regression: replacing the bare enqueue with `resolveTriggeredPanel` kept
the warm and still failed the check.

**How to apply:** when you move a call out of this loader, repair the LITERAL in
the test to name the new seam and say why in a comment. Do not revert the code
to satisfy a check whose intent your change still meets.

Related: [[project_enrichment_trigger_is_the_shared_seam]]
