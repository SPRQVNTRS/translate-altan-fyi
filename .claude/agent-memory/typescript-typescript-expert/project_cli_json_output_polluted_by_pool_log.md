---
name: translate-cli-entrypoint-is-a-dynamic-import-launcher
description: cli/index.ts sets LOG_LEVEL then dynamically imports cli/main.ts, because a static import is hoisted above the assignment and used to leak a pool log onto stdout JSON
metadata:
  type: project
---

`cli/index.ts` in translate-altan-fyi is a LAUNCHER and must contain no static
import. It assigns `CLI_MODE` and `LOG_LEVEL='error'`, then loads the body from
`cli/main.ts` via a dynamic `import()` inside a `launch()` function.

**Why:** every logger here reads `process.env.LOG_LEVEL` once, at module
evaluation, in module scope. `drizzle/db.ts` builds its OWN logger with
`createServerLogger` (it does not use `app/lib/logger.ts`), and `app/lib/logger.ts`
does the same with `createLogger`. ESM hoists static `import` declarations above
all statements, so a static import in the entrypoint evaluated `drizzle/db.ts` at
`.env`'s `LOG_LEVEL=info` before the assignment ran. `closePool()` then wrote an
INFO `Database pool closed` line to STDOUT after the payload of every
`--format=json` command, and `pnpm cli ... --format=json | jq` always failed to
parse. Fixed 2026-09-03; `tests/unit/cli-entrypoint-suppresses-logging.test.ts`
guards it, and that guard was falsified before being accepted.

**Stderr was rejected, not overlooked.** `@sprqvntrs/logger`'s
`CreateLoggerOptions` has no destination field (`level`, `pretty`,
`redactPaths`, `base`, `timestamp` only) and `createPinoInstance` calls
`pino(config)` with no destination, so it writes to fd 1. The package exports no
way to wrap an external pino instance, so stderr means reimplementing the
`Logger` wrapper locally. That belongs upstream as a `destination` option.

**How to apply:** never add a static import to `cli/index.ts`; put it in
`cli/main.ts`. Suppression is by LEVEL only, so a `logger.error` on a CLI path
still lands on stdout and still breaks a `jq` pipe. Use `printError` from
`cli/lib/output`, which writes to stderr.
Related: [[translate-altan-fyi-verify-commands]], [[translate-cli-must-call-closepool]],
[[translate-cli-format-option-is-per-subcommand]].
