---
name: project-translate-dirty-tree-parallel-rebrand
description: this repo's working tree can carry a large uncommitted parallel rebrand (colors, icons, welcome page) alongside a naming-only task
metadata:
  type: project
---

During the 2026-09-05 translate -> Kenning naming rename, the working tree
already had ~20 unrelated uncommitted files mid-edit: `app/app.css` (a full
palette swap from "Open blue" to a warm ochre read off "the Kenning brand
mark"), `public/icons/*` (regenerated binaries), `app/welcome/*` deleted, and
several `app/components/ui/*` tweaks. `DESIGN.md`'s own uncommitted diff
explained the palette move and named "the Kenning brand mark" explicitly, so
this was a real, intentional parallel visual-rebrand effort, not junk.

**Why:** a naming-only task (host, package.json, brand string) and a visual
identity task (colors, icon assets, wordmark art) were being done in the same
worktree by different sessions at the same time.

**How to apply:** before touching any file for a rename/rebrand task in this
repo, run `git status --porcelain` FIRST and diff the intended file list
against it. Only touch files your task's grep/scope actually names; do not
`git checkout --` or revert files you did not intend to change just because
they look unrelated to your diff. Report the pre-existing dirty state to the
user rather than silently absorbing or discarding it. See
[[project_translate_kenning_rename]].
