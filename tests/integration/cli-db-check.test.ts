/**
 * Integration test: `cli db check`
 *
 * Skips if TEST_API_KEY env var is not set.
 * Requires a running server at http://localhost:3456.
 * Requires the API key to belong to a superadmin user.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const TEST_API_KEY = process.env.TEST_API_KEY;
const REMOTE_URL = process.env.TEST_REMOTE_URL ?? 'http://localhost:3456';
const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

// Strip ANSI escape sequences for plain-text assertions
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

describe('cli db check', () => {
  it('reports database connection as healthy', { skip: !TEST_API_KEY ? 'TEST_API_KEY not set' : false }, () => {
    const result = spawnSync(
      'node_modules/.bin/tsx',
      ['cli/index.ts', '--remote', REMOTE_URL, 'db', 'check'],
      {
        encoding: 'utf8',
        env: { ...process.env, TRANSLATE_API_KEY: TEST_API_KEY },
        cwd: PROJECT_ROOT,
        timeout: 15000,
      },
    );

    assert.equal(result.status, 0, `Exit code ${result.status ?? 'null'}: ${result.stderr}`);
    const output = stripAnsi(result.stdout);
    assert.ok(
      output.includes('Database') || output.includes('connected') || output.includes('OK'),
      `Expected db check success output, got: ${output.slice(0, 200)}`,
    );
  });
});
