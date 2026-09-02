/**
 * Mechanical guards for two operator design rules:
 *
 *   1. Never use a thick left border to accentuate an element.
 *   2. Never use em dashes in copy, use a comma instead.
 *
 * The test walks the source tree itself rather than checking a hardcoded file
 * list: a list stops covering new files the moment someone adds one, which is
 * exactly the failure this test exists to prevent. Every hit is collected and
 * reported together with its file and 1-based line number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Directories that hold generated or vendored code, never authored copy. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', '.react-router']);

/** A single rule violation, addressed the way a reader would open it. */
type Hit = {
  file: string;
  line: number;
  text: string;
};

/** The narrowest left border that still reads as an accent bar. */
const THICK_BORDER_PX = 3;

/** Tailwind scale form: `border-l-4`. `border-l` and `border-l-2` are thin, and legitimate. */
const TAILWIND_SCALE = /border-l-(\d+)\b/g;

/** Tailwind arbitrary form: `border-l-[4px]`. */
const TAILWIND_ARBITRARY = /border-l-\[(\d+(?:\.\d+)?)px\]/g;

/** CSS form, whitespace tolerant: `border-left:4px`, `border-left:   4px`, `border-left-width: 4px`. */
const CSS_DECLARATION = /border-left(?:-width)?\s*:\s*(\d+(?:\.\d+)?)px/g;

/** Written as an escape on purpose, so this file does not trip its own rule. */
const EM_DASH = '\u2014';

function walk(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...walk(full, extensions));
      continue;
    }
    if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
    found.push(relative(REPO_ROOT, full));
  }
  return found;
}

function collect(directory: string, extensions: readonly string[]): string[] {
  return walk(join(REPO_ROOT, directory), extensions).toSorted();
}

/** Lines carrying a left border of `THICK_BORDER_PX` or heavier, in any of the three notations. */
function findThickLeftBorders(source: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const pattern of [TAILWIND_SCALE, TAILWIND_ARBITRARY, CSS_DECLARATION]) {
      for (const match of line.matchAll(pattern)) {
        const width = Number(match[1]);
        if (!Number.isFinite(width) || width < THICK_BORDER_PX) continue;
        hits.push({ line: index + 1, text: match[0] });
      }
    }
  }
  return hits;
}

/** Lines containing U+2014. */
function findEmDashes(source: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes(EM_DASH)) continue;
    hits.push({ line: index + 1, text: line.trim() });
  }
  return hits;
}

type Scanner = (source: string) => { line: number; text: string }[];

function scan(files: readonly string[], scanner: Scanner): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const hit of scanner(source)) {
      hits.push({ file, line: hit.line, text: hit.text });
    }
  }
  return hits;
}

function report(rule: string, hits: readonly Hit[]): string {
  const lines = hits.map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`);
  return `${rule}\n${hits.length} violation(s):\n${lines.join('\n')}`;
}

const appTsx = collect('app', ['.tsx']);
const appCss = collect('app', ['.css']);
const cliTs = collect('cli', ['.ts']);

describe('design rules', () => {
  it('scans a non-trivial number of files (guards against a broken walk)', () => {
    assert.ok(appTsx.length >= 20, `expected at least 20 app/**/*.tsx files, walked ${appTsx.length}`);
    assert.ok(appCss.length >= 1, `expected at least 1 app/**/*.css file, walked ${appCss.length}`);
    assert.ok(cliTs.length >= 5, `expected at least 5 cli/**/*.ts files, walked ${cliTs.length}`);
    // A file list is worthless if the files are unreadable or empty.
    const totalBytes = [...appTsx, ...appCss, ...cliTs].reduce(
      (sum, file) => sum + readFileSync(join(REPO_ROOT, file), 'utf8').length,
      0,
    );
    assert.ok(totalBytes > 10_000, `walked files hold only ${totalBytes} characters`);
  });

  it('detects thick left borders and ignores thin ones', () => {
    assert.deepEqual(findThickLeftBorders('<div className="border-l border-l-2 pl-4" />'), []);
    assert.deepEqual(findThickLeftBorders('border-left: 2px solid red;'), []);
    assert.deepEqual(findThickLeftBorders('<div className="border-l-red-500" />'), []);
    assert.equal(findThickLeftBorders('<div className="border-l-4" />').length, 1);
    assert.equal(findThickLeftBorders('<div className="border-l-[3px]" />').length, 1);
    assert.equal(findThickLeftBorders('border-left:4px solid red;').length, 1);
    assert.equal(findThickLeftBorders('border-left:   3px solid red;').length, 1);
  });

  it('detects em dashes and ignores hyphens and en dashes', () => {
    assert.deepEqual(findEmDashes('a well-formed line, with a comma – and an en dash'), []);
    assert.equal(findEmDashes(`copy ${EM_DASH} with an em dash`).length, 1);
  });

  it('uses no thick left border in app/**/*.{css,tsx}', () => {
    const hits = scan([...appCss, ...appTsx], findThickLeftBorders);
    assert.deepEqual(hits, [], report('Never use a thick left border to accentuate an element.', hits));
  });

  it('uses no em dash in app/**/*.tsx and cli/**/*.ts', () => {
    const hits = scan([...appTsx, ...cliTs], findEmDashes);
    assert.deepEqual(hits, [], report('Never use em dashes in copy, use a comma instead.', hits));
  });
});
