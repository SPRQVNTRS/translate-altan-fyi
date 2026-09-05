---
name: translate-candidate-note-prompt-v2
description: The per-candidate usage note rides on the translation answer, is optional, and bumping the prompt copies v1.md to v2.md and deletes v1
metadata:
  type: project
---

M196 added `note` to `translationCandidateSchema`
(`z.string().min(1).max(160).optional()`), to `translations.note` (nullable
forever) and to `TranslationRow`. It is OPTIONAL on purpose: a required note
makes the model invent a usage claim for a lone candidate with nothing to
disambiguate, and a wrong note reads as authoritative. It is not `register`,
which stays a one-word label.

`upsertTranslationEdge` writes `params.note ?? null` on the insert AND in the
`onConflictDoUpdate` set, so a re-run that dropped the note clears the stale one
rather than leaving it beside a new confidence.

**Why:** bumping a prompt here is a RENAME, not a copy. `v1.md` was deleted, and
`PROMPT_PATH_FROM_REPO_ROOT`, the `new URL('./vN.md', import.meta.url)`
candidate and `PROMPT_VERSION` in `version.ts` all move together. A stale
`vN-1.md` on disk is a second answer to "which prompt is live", and
`PROMPT_VERSION` is part of the pg-boss dedupe key, so a bump is what gives a
reworded prompt a second chance at an already-answered headword.

**How to apply:** three files per bump, plus the markdown rename. The phrase
prompt (`app/prompts/phrase/`) versions independently.

Related: [[translate-rank-is-the-one-order]]
