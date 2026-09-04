#!/usr/bin/env node
/**
 * translate-altan-fyi CLI entrypoint.
 *
 * Usage:
 *   pnpm cli --help
 *   pnpm cli user list
 *   pnpm cli workflow list --status=failed
 *   TRANSLATE_API_KEY=<key> pnpm cli --remote=http://localhost:3000 api-key list --org=default
 *
 * This file is a launcher and nothing else. It sets two environment variables,
 * then loads the real body through a DYNAMIC import. The dynamic form is the
 * whole point, and it is not stylistic.
 *
 * `LOG_LEVEL` is read once, at module evaluation, by every logger this app
 * builds: `app/lib/logger.ts` and `drizzle/db.ts` both pass
 * `process.env.LOG_LEVEL` into their factory call in module scope. ESM hoists
 * every static `import` declaration above all statements in the module body, so
 * a plain `import './main'` here would evaluate `drizzle/db.ts`, build its
 * logger at `.env`'s `LOG_LEVEL=info`, and only THEN run the assignments below.
 * That is exactly what this file used to do, under a comment claiming it
 * suppressed logging "BEFORE any imports". It did not, and the visible cost was
 * that `closePool()` wrote an INFO line, `Database pool closed`, to STDOUT after
 * the payload of every `--format=json` command, so piping the CLI into `jq`
 * always failed to parse.
 *
 * A dynamic `import()` is evaluated where it is written, not hoisted, so the
 * assignments genuinely precede the graph.
 *
 * The rejected alternative was to send log output to stderr instead, which
 * would fix this class of bug for good rather than only suppressing it by
 * level. `@sprqvntrs/logger` has no destination option: `CreateLoggerOptions`
 * carries `level`, `pretty`, `redactPaths`, `base` and `timestamp`, and
 * `createPinoInstance` calls `pino(config)` with no destination, so it writes
 * to fd 1. Taking that route means reimplementing the package's `Logger`
 * wrapper here over a local pino instance, and diverging from the shared
 * package on every consumer. It belongs upstream, as a `destination` option on
 * `createLogger`, not as a fork in this repo.
 *
 * Consequence to know about: the launcher suppresses by LEVEL. Anything logged
 * at `error` or `fatal` during a CLI run still lands on stdout and still breaks
 * a `jq` pipe. Keep diagnostics in CLI code paths out of the logger and in
 * `printError`, which already writes to stderr.
 */

process.env.CLI_MODE = 'true';
process.env.LOG_LEVEL = 'error';

/**
 * Wrapped in a function rather than run as a top-level `await` on purpose. A
 * top-level `await` needs the file to be a module, and with no static import
 * here the only way to say so is a bare `export {}`, which the lint gate
 * rejects as empty braces. Inside a function the `import()` is unambiguously
 * evaluated at call time, which is the property this whole file exists for.
 */
async function launch(): Promise<void> {
  const { runCli } = await import('./main');
  await runCli();
}

void launch();
