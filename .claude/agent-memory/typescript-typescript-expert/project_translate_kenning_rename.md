---
name: project-translate-kenning-rename
description: translate.altan.fyi renamed to Kenning/kenning.altan.fyi (2026-09-05), what changed and what was deliberately left alone
metadata:
  type: project
---

On 2026-09-05 the product `translate.altan.fyi` was renamed to `Kenning`
(`kenning.altan.fyi`). The single source of truth for the display brand name is
`app/lib/app-name.ts` (`APP_NAME`) — `app/components/app-sidebar.tsx`'s `Logo()`
and `app/components/public-wrapper.tsx` both import it rather than hardcoding a
literal; before this rename `app-sidebar.tsx` had its own hardcoded `'t'` /
`'translate'` literals that had drifted from the constant, so check for that
kind of drift again on any future rename.

**Why:** a kenning is the Old Norse figure that names a thing by describing it.
The word "translate" stays everywhere it means the verb or the route: `/translate`,
`translateHeadword`, `translations` tables, `TRANSLATE_API_KEY`,
`TRANSLATE_PROD_URL`, the nav/submit-button label "Translate", and
`search.metaTitle`/`Übersetzen` (confirmed by the German being the verb, not a
brand word, so it's a page-purpose label like every other route's `metaTitle`,
not the app name).

**How to apply:** if asked to touch branding again, `APP_NAME` is the one place
to change the display name. Dated, historical "launch check" documents
(`docs/launch-checks.md`, `.reports/*.md`) record what was actually probed
against the OLD domain on a specific date and should not be rewritten to the
new domain, same rule as `.adr/` and historical AGENTS.md passages. Live
config-describing text (current EMAIL_FROM default, ADR prose describing an
ongoing fact) does get updated. See [[project_translate_dirty_tree_parallel_rebrand]].
