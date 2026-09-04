---
name: search-panes-is-the-shared-surface
description: The two-pane translator markup lives in app/components/search-panes.tsx, not in routes/search.tsx, and two source-grep unit tests follow it there
metadata:
  type: project
---

Since M186/01 the textarea, the form, the voice control, the result list and the
inline enrichment panel are `SearchPanes` (`app/components/search-panes.tsx`),
pure over its props. `routes/search.tsx` keeps the loader, `DailyNudge`,
`RecordSearch` and `Landing` only.

**Why:** the search loader gates every non-empty `q` behind an account, so an
ANSWERED surface can only be rendered without a session by handing the answer to
a component. `/dev/design-review` does that. `RecordSearch` stayed in the route
on purpose: a review page must not write invented searches into local history.

**How to apply:** two unit tests read the surface as TEXT and now point at
`search-panes.tsx`: `voice-input-textarea-submit.test.ts` (Textarea/VoiceInput/Form
wiring) and `phrase-truncation-notice.test.ts` (the pane half; the loader half
still reads `search.tsx`). Related: [[project_search_tsx_has_source_grep_tests]].
