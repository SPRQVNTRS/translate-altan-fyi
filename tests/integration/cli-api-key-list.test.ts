/**
 * Integration test: `cli api-key list`
 *
 * There is no `--org` any more: a key belongs to nobody since M189, so a
 * listing is the whole set and the endpoint asks for a superadmin key.
 *
 * Skips if TEST_API_KEY env var is not set.
 * Requires a running server at http://localhost:3456.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const TEST_API_KEY = process.env.TEST_API_KEY;
const REMOTE_URL = process.env.TEST_REMOTE_URL ?? 'http://localhost:3456';
const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

describe('cli api-key list', () => {
  it('lists api keys and returns JSON array', { skip: !TEST_API_KEY ? 'TEST_API_KEY not set' : false }, () => {
    const result = spawnSync(
      'node_modules/.bin/tsx',
      ['cli/index.ts', '--remote', REMOTE_URL, 'api-key', 'list', '--format=json'],
      {
        encoding: 'utf8',
        env: { ...process.env, TRANSLATE_API_KEY: TEST_API_KEY },
        cwd: PROJECT_ROOT,
        timeout: 15000,
      },
    );

    assert.equal(result.status, 0, `Exit code ${result.status ?? 'null'}: ${result.stderr}`);
    // api-key list outputs the standard paginated envelope { data, total, limit, offset }
    assert.ok(
      result.stdout.includes('"data"'),
      `Expected response with data field, got: ${result.stdout.slice(0, 200)}`,
    );
  });
});
