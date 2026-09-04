---
name: translate-cli-format-option-is-per-subcommand
description: translate-altan-fyi's CLI has no global --format; it is declared per subcommand, so `pnpm cli --format=json <group> <cmd>` errors with "unknown option"
metadata:
  type: project
---

In `translate-altan-fyi/cli/`, `-f, --format <format>` is declared on each
LIST subcommand (`api-key list`, `user list`, `organization list`,
`data-source list`), never on `program`. The program's only global options are
`--no-color`, `--remote`, `--prod`, `--token`.

`pnpm cli --format=json account list-invites` therefore exits 1 with
`error: unknown option '--format=json'`. The working form is
`pnpm cli account list-invites --format=json`.

**Why:** `program.enablePositionalOptions()` means anything before the subcommand
must be a declared program option, and adding a global `--format` that only some
subcommands honour would be a silent no-op footgun on the rest.
**How to apply:** follow the per-subcommand convention on any new list command, and
flag a spec check that puts `--format` before the command group as unsatisfiable
rather than adding the global option to make it pass.
Related: [[translate-cli-json-output-polluted-by-pool-log]].
