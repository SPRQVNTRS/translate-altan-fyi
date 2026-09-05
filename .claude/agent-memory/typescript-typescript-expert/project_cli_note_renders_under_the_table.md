---
name: cli-note-renders-under-the-table
description: a whole-sentence field gets a line under the CLI table, never a fifth column
metadata:
  type: project
---

`cli/commands/translate.ts` prints the usage note as `printField(lemma, note)`
lines AFTER the table, not as a column of `ANSWER_COLUMNS`.

**Why:** a note is a whole sentence. A fifth column either wraps every cell and
destroys the row alignment the table exists for, or truncates a usage rule to a
fragment. Leaving it to `-f json` was rejected too: the default format is what an
operator reads, so a JSON-only field is the same screen/terminal drift again.

**How to apply:** any future sentence-length field on a CLI row follows this
shape. A row whose value is `null` prints nothing, never `(none)`.
