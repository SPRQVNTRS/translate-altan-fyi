/**
 * The rendered prompt, and the guard that stands behind it.
 *
 * WHY THE PLACEHOLDER CASE MATTERS MOST
 *   A prompt that still carries `{{lemma}}` is not a broken prompt, it is a
 *   VALID prompt about the wrong thing. The model answers it, the answer parses,
 *   and the notes get cached against a word they do not describe. Nothing later
 *   in the chain can tell that apart from a correct run, so the assertion that
 *   no `{{` survives is the only place the failure can be caught.
 *
 * WHY THE LOAD-TIME CASE MATTERS NEXT
 *   The markdown is not emitted by the bundler, so the path this module reads is
 *   only correct while the TypeScript sources are what runs. This tier is one of
 *   the places that runs the sources, so it can never see the production fault
 *   itself. What it CAN hold is the two properties that make the fault
 *   survivable: importing the module reads nothing, and a missing file throws a
 *   named error naming both paths, rather than rendering an empty prompt.
 *
 * NO DATABASE AND NO NETWORK. The template is read from disk on the first
 * render, and nothing else touches the file system.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  isTemplateLoaded,
  PROMPT_VERSION,
  PromptFileNotShippedError,
  promptPathCandidates,
  renderEnrichmentPrompt,
  resolvePromptPath,
  substitutePlaceholders,
  UnresolvedPlaceholderError,
} from '../../app/prompts/enrichment/index';

/**
 * Sampled at THIS file's module scope, which runs immediately after the module
 * under test has been imported and before any `it` body. Reading it here rather
 * than inside a test makes the assertion independent of test ordering: no case
 * can render first and make a module-load read look lazy.
 */
const WAS_LOADED_AT_IMPORT_TIME = isTemplateLoaded();

const FIRST_SENSE_ID = '11111111-2222-4333-8444-555555555555';
const SECOND_SENSE_ID = '99999999-8888-4777-8666-555555555555';

function renderRunPrompt(pos: string | null) {
  return renderEnrichmentPrompt({
    lemma: 'run',
    pos,
    from: 'en',
    to: 'de',
    senses: [
      { senseId: FIRST_SENSE_ID, glosses: ['to move quickly on foot', 'to jog'] },
      { senseId: SECOND_SENSE_ID, glosses: ['to operate a machine'] },
    ],
  });
}

describe('PROMPT_VERSION', () => {
  it('is 1', () => {
    // Stored on every enrichment row, so a silent bump would make old rows and
    // new rows look like the same cache entry.
    assert.equal(PROMPT_VERSION, 1);
  });
});

describe('reading the template', () => {
  it('does not read the file when the module is merely imported', () => {
    // The route graph imports this module transitively, so a read at module
    // scope is a read on the web server's boot path. That is the exact shape of
    // the crash this test exists for: the built server died on a missing file
    // before it ever listened.
    assert.equal(
      WAS_LOADED_AT_IMPORT_TIME,
      false,
      'the template was read at module load, which puts a disk read on the boot path',
    );
  });

  it('reads the file on the first render, and only then', () => {
    renderRunPrompt('verb');
    assert.equal(isTemplateLoaded(), true, 'rendering did not load the template');
  });

  it('finds the markdown from the repository root, where the image ships it', () => {
    // `process.cwd()` is the repository root under the test runner, which is the
    // same shape production has: `Dockerfile.pnpm` sets `WORKDIR /app` over a
    // `COPY . /app`, so the repo-relative copy is on disk there too.
    const path = resolvePromptPath();
    assert.ok(existsSync(path), `resolvePromptPath returned a path that does not exist: ${path}`);
  });

  it('offers the repository-root copy as a candidate, not just the module-relative one', () => {
    // The module-relative candidate is the one that MOVES when the bundler
    // rewrites this module into build/server/. The second candidate is the only
    // thing standing between production and a boot crash.
    const candidates = promptPathCandidates();
    assert.equal(candidates.length, 2, 'expected exactly two candidate paths');
    assert.ok(
      candidates.some((candidate) => candidate.endsWith('app/prompts/enrichment/v1.md')),
      'the repository-root candidate is missing',
    );
  });

  it('throws a named error naming both paths when the file was not shipped', () => {
    // Never an empty-string fallback. A blank prompt would still get an answer,
    // and that answer would still be cached against the headword.
    const candidates = ['/build/server/v1.md', '/app/app/prompts/enrichment/v1.md'];
    try {
      resolvePromptPath({ candidates, exists: () => false });
      assert.fail('a missing prompt file did not throw');
    } catch (cause) {
      assert.ok(cause instanceof PromptFileNotShippedError);
      assert.equal(cause.name, 'PromptFileNotShippedError');
      for (const candidate of candidates) {
        assert.ok(cause.message.includes(candidate), `the error does not name ${candidate}`);
      }
      assert.match(cause.message, /not shipped/u);
    }
  });

  it('takes the first candidate that exists, in the order given', () => {
    const candidates = ['/first/v1.md', '/second/v1.md'];
    assert.equal(
      resolvePromptPath({ candidates, exists: (candidate) => candidate === '/second/v1.md' }),
      '/second/v1.md',
      'the fallback candidate was not reached',
    );
    assert.equal(
      resolvePromptPath({ candidates, exists: () => true }),
      '/first/v1.md',
      'the first candidate did not win',
    );
  });
});

describe('renderEnrichmentPrompt', () => {
  it('carries the lemma, both language names, every sense id and every gloss', () => {
    const prompt = renderRunPrompt('verb');

    assert.ok(prompt.includes('run'), 'the lemma is missing');
    assert.ok(prompt.includes('English'), 'the source language name is missing');
    assert.ok(prompt.includes('German'), 'the target language name is missing');
    assert.ok(prompt.includes('verb'), 'the part of speech is missing');

    for (const senseId of [FIRST_SENSE_ID, SECOND_SENSE_ID]) {
      assert.ok(prompt.includes(senseId), `sense id ${senseId} is missing`);
    }
    for (const gloss of ['to move quickly on foot', 'to jog', 'to operate a machine']) {
      assert.ok(prompt.includes(gloss), `gloss "${gloss}" is missing`);
    }
  });

  it('leaves no placeholder behind', () => {
    const prompt = renderRunPrompt('verb');
    assert.ok(
      !prompt.includes('{{'),
      `the rendered prompt still carries a placeholder:\n${prompt}`,
    );
  });

  it('renders the fallback text when the headword has no part of speech', () => {
    const prompt = renderRunPrompt(null);
    assert.ok(prompt.includes('not recorded'), 'the part-of-speech fallback is missing');
    assert.ok(!prompt.includes('{{'), 'the fallback path left a placeholder behind');
  });
});

describe('substitutePlaceholders', () => {
  it('fills in every placeholder it has a value for', () => {
    const rendered = substitutePlaceholders('Hello {{name}}, welcome to {{place}}.', {
      name: 'Ada',
      place: 'Berlin',
    });
    assert.equal(rendered, 'Hello Ada, welcome to Berlin.');
  });

  it('throws when the template holds a placeholder with no value behind it', () => {
    assert.throws(
      () => substitutePlaceholders('Hello {{name}}, about {{lemmaa}}.', { name: 'Ada' }),
      UnresolvedPlaceholderError,
    );
  });

  it('names the surviving placeholder in the error, so the drift is findable', () => {
    try {
      substitutePlaceholders('About {{lemmaa}}.', { lemma: 'run' });
      assert.fail('the guard did not throw');
    } catch (cause) {
      assert.ok(cause instanceof UnresolvedPlaceholderError);
      assert.match(cause.message, /\{\{lemmaa\}\}/u);
    }
  });
});
