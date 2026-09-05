/**
 * Guards public/ against ever again shipping a dotfile to production.
 *
 * The incident this prevents: a subagent once wrote its memory notes to
 * public/.claude/agent-memory/..., three levels deep. server.ts serves
 * build/client wholesale via express.static, and the build step copies
 * public/ into build/client verbatim, so those files were reachable at the
 * site root in production. They were removed by hand; nothing stopped it
 * from happening again until this test.
 *
 * The test walks public/ recursively, at any depth, and fails on any entry
 * whose name starts with a dot. The one deliberate exception is
 * .well-known/, a real, intentionally public directory (already present in
 * this repo for things like Chrome DevTools' workspace probe), and
 * everything under it.
 *
 * The fix for a violation is to delete or relocate the offending path, never
 * to add it to .gitignore: an ignore rule hides the file from git while the
 * build still copies it into build/client, which is worse than the current
 * state because it also hides the mistake from `git status`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC_ROOT = join(REPO_ROOT, 'public');

/** The one dotted directory that is allowed to exist under public/, and everything inside it. */
const ALLOWED_DOTTED_NAME = '.well-known';

type Entry = {
  /** Path relative to public/, the way an operator would address it. */
  relativePath: string;
  isDirectory: boolean;
};

/** Every file and directory under public/, at any depth, in a stable order. */
function walk(directory: string): Entry[] {
  const found: Entry[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const relativePath = relative(PUBLIC_ROOT, full);
    found.push({ relativePath, isDirectory: entry.isDirectory() });
    if (entry.isDirectory()) {
      found.push(...walk(full));
    }
  }
  return found.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** True when any path segment, the entry itself or an ancestor, starts with a dot. */
function hasDottedName(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

/** True when the entry is .well-known itself, or lives underneath it. */
function isUnderAllowedDottedDirectory(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments[0] === ALLOWED_DOTTED_NAME;
}

function findDottedEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => hasDottedName(entry.relativePath) && !isUnderAllowedDottedDirectory(entry.relativePath));
}

function report(offenders: readonly Entry[]): string {
  const lines = offenders.map((entry) => `  public/${entry.relativePath}${entry.isDirectory ? '/' : ''}`);
  return [
    'public/ is copied into build/client and served wholesale by server.ts via express.static.',
    'Any dotfile or dotted directory in public/ becomes publicly reachable in production.',
    `${offenders.length} offending path(s):`,
    ...lines,
  ].join('\n');
}

const allEntries = walk(PUBLIC_ROOT);

describe('public/ tree is clean', () => {
  it('walks a non-trivial number of entries (guards against a broken walk)', () => {
    assert.ok(allEntries.length >= 5, `expected at least 5 entries under public/, walked ${allEntries.length}`);
    const fileCount = allEntries.filter((entry) => !entry.isDirectory).length;
    assert.ok(fileCount >= 3, `expected at least 3 files under public/, found ${fileCount}`);
    for (const entry of allEntries) {
      const full = join(PUBLIC_ROOT, entry.relativePath);
      assert.ok(statSync(full), `walked entry public/${entry.relativePath} is not statable`);
    }
  });

  it('identifies dotted names and exempts .well-known', () => {
    assert.equal(hasDottedName('.claude'), true);
    assert.equal(hasDottedName('.claude/agent-memory/notes.md'), true);
    assert.equal(hasDottedName('icons/icon.svg'), false);
    assert.equal(isUnderAllowedDottedDirectory('.well-known/appspecific/com.chrome.devtools.json'), true);
    assert.equal(isUnderAllowedDottedDirectory('.claude/agent-memory/notes.md'), false);
  });

  it('has no dotted files or directories under public/, other than .well-known', () => {
    const offenders = findDottedEntries(allEntries);
    assert.deepEqual(offenders, [], report(offenders));
  });
});
