---
name: drizzle-generate-needs-a-pty
description: drizzle-kit's create-or-rename prompt needs a real TTY, and a drop-table plus drop-constraint in one migration fails at apply time
metadata:
  type: project
---

Two things bite when a `drizzle:generate` touches a table AND drops the tables
it referenced.

**1. The prompt needs a pty.** Dropping two columns and adding one in the same
table makes drizzle-kit ask "created or renamed from another column?". Piping
`printf '\r'` does nothing and `script -qec` hangs. Drive it from Python:

```python
pid, fd = pty.fork()
if pid == 0: os.execvp("toolbox", ["toolbox","run","-c","ts-dev","env","CI=true","pnpm","drizzle:generate"])
# read fd until b"created or renamed" appears, then os.write(fd, b"\r") for the default
```

**2. One migration cannot both `DROP TABLE ... CASCADE` and
`ALTER TABLE x DROP CONSTRAINT`.** drizzle-kit emits the drops first, the
CASCADE already removed the foreign keys, and the later `DROP CONSTRAINT` fails
with `42704 constraint ... does not exist`. The whole migration rolls back, so
nothing is half applied.

**How to apply:** split it across two generate runs, the same remedy as
[[project_drizzle_kit_cannot_change_a_column_type]]. Put the surviving table's
`ALTER` in the FIRST migration, generated against a schema that still has the
doomed tables, then delete them in the second. To discard a bad generated
migration, `rm` the `.sql` and its `NNNN_snapshot.json` and
`git checkout drizzle/migrations/meta/_journal.json`; never hand-edit a `when`.

Related: [[project_getrawdb_is_the_only_handle]]
