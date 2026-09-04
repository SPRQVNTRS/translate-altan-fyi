/**
 * Guard: `cli/index.ts` must contain no STATIC import declaration.
 *
 * The CLI suppresses logging by assigning `process.env.LOG_LEVEL = 'error'` in
 * its entrypoint. Every logger in this app reads `process.env.LOG_LEVEL` once,
 * at module evaluation, in module scope: `app/lib/logger.ts` and
 * `drizzle/db.ts` both pass it straight into their factory call. ESM hoists
 * every static `import` declaration above all statements in the module body, so
 * a single static import in the entrypoint evaluates that whole graph at
 * `.env`'s `LOG_LEVEL=info` and the assignment lands too late to matter.
 *
 * That is not hypothetical. It is what the file used to do, under a comment
 * claiming it suppressed logging "BEFORE any imports". The visible cost was
 * `closePool()` writing an INFO line, `Database pool closed`, to STDOUT after
 * the payload of every `--format=json` command, so piping the CLI into `jq`
 * always failed to parse. The body moved to `cli/main.ts` and the entrypoint
 * now loads it through a dynamic `import()`, which is evaluated where it is
 * written rather than hoisted.
 *
 * The failure mode this test exists for is silent: adding one innocent-looking
 * static import to the entrypoint restores the bug with no error anywhere, and
 * nothing else in the gate would notice, because JSON output is only consumed
 * by machines downstream of the tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolved from the module's own location so the working directory is irrelevant. */
const CLI_DIR = resolve(import.meta.dirname, '../../cli');

/**
 * Strip block and line comments so the assertions read code, not prose. The
 * entrypoint's own doc comment names `import './main'` while explaining why it
 * must not appear, and a whole-file match would otherwise fail on that.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A static `import ...` or a re-exporting `export ... from ...` at statement
 * position. Line scoped rather than greedy, so an `export` that carries nothing
 * into the graph cannot be paired with a `from` further down the file.
 */
const STATIC_IMPORT_PATTERN = /^\s*(import[\s{]|export\s[^\n]*\sfrom\s)/gm;

function readCliFile(name: string): string {
  return readFileSync(resolve(CLI_DIR, name), 'utf8');
}

describe('cli entrypoint logging suppression', () => {
  it('has no static import in cli/index.ts, so the env assignments run first', () => {
    const code = stripComments(readCliFile('index.ts'));
    const matches = code.match(STATIC_IMPORT_PATTERN) ?? [];
    assert.deepEqual(
      matches,
      [],
      'cli/index.ts must load its body through a dynamic import(); a static import is hoisted above the LOG_LEVEL assignment',
    );
  });

  it('assigns LOG_LEVEL and CLI_MODE before it imports the body', () => {
    const code = stripComments(readCliFile('index.ts'));
    const logLevelAt = code.indexOf("process.env.LOG_LEVEL = 'error'");
    const cliModeAt = code.indexOf("process.env.CLI_MODE = 'true'");
    const dynamicImportAt = code.search(/\bimport\s*\(/);

    assert.notEqual(logLevelAt, -1, 'cli/index.ts must set LOG_LEVEL');
    assert.notEqual(cliModeAt, -1, 'cli/index.ts must set CLI_MODE');
    assert.notEqual(dynamicImportAt, -1, 'cli/index.ts must load its body dynamically');
    assert.ok(logLevelAt < dynamicImportAt, 'LOG_LEVEL must be set before the dynamic import');
    assert.ok(cliModeAt < dynamicImportAt, 'CLI_MODE must be set before the dynamic import');
  });

  it('keeps the command graph in cli/main.ts, not in the entrypoint', () => {
    const code = stripComments(readCliFile('main.ts'));
    assert.ok(
      (code.match(STATIC_IMPORT_PATTERN) ?? []).length > 0,
      'cli/main.ts is the body and holds the static imports; an empty one means the split was undone',
    );
    assert.ok(
      code.includes('export async function runCli'),
      'cli/main.ts must export runCli(), which cli/index.ts awaits',
    );
  });
});
