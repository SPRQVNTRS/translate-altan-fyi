---
name: translate-phrase-token-limit
description: searchPhrase looks up only the first PHRASE_TOKEN_LIMIT words and makes no LLM call; the route reports the shortfall
metadata:
  type: project
---

In `translate-altan-fyi`, `searchPhrase`
(`app/lib/dictionary/search.server.ts`) does two things worth knowing:

- It makes **no LLM call and enqueues no enrichment**. It is
  `searchHeadwords` once per looked-up word plus one example query, all SQL.
  So the phrase branch, which the translator textarea made the main path,
  costs nothing new in provider spend. The only warm on `/search` is the
  single-word branch's top-hit `enqueueEnrichmentInBackground`.
- It looks up only `query.tokens.slice(0, PHRASE_TOKEN_LIMIT)` (6). The
  EXAMPLE containment test still uses the whole phrase
  (`query.tokens.join(' ')`), so truncation bounds the WORD LIST only.

**Why:** under the old one-line box nobody typed a paragraph, so the cap was
invisible. A textarea invites a paste, and words seven onward were silently
dropped: a partly read query rendering as a whole answer.
**How to apply:** the loader returns
`phraseWordsOmitted = query.tokens.length - phrase.tokens.length`, computed
from what the search ACTUALLY looked at rather than from the constant, and the
output pane renders `search.phraseTruncatedNote` when it is above zero. Keep
that subtraction if you touch the cap. Tests:
`tests/unit/phrase-truncation-notice.test.ts`,
`tests/unit/phrase-branch-routes-to-search-phrase.test.ts`.
Related: [[translate-altan-fyi-verify-commands]], [[translate-voice-input-takes-a-sink]].
