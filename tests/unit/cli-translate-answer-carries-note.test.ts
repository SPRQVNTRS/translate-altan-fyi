/**
 * THE CLAIM: THE CLI HANDS BACK THE SAME ANSWER THE SCREEN RENDERS, NOTE
 * INCLUDED.
 *
 * WHY THIS IS WORTH A TEST OF ITS OWN
 *   `translateAnswerSchema` is the CLI's boundary parse, and `z.object` strips
 *   every key it was not told about. A field the server sends and this schema
 *   omits is therefore not a missing feature, it is a DISCARDED one: the answer
 *   arrives complete over the wire and the CLI throws part of it away, silently,
 *   with no error anywhere to read. That is precisely how `note` came to be on
 *   the screen and absent from `pnpm cli translate ... -f json`, and it is the
 *   drift ADR-0001 exists to prevent.
 *
 *   Three things are pinned here:
 *
 *   1. A note that arrives SURVIVES the parse.
 *   2. `null` is ACCEPTED, because the phrase branch sets it to null by
 *      construction and every imported edge carries none.
 *   3. The key is REQUIRED. A server that stopped sending it fails loudly here
 *      rather than answering an operator with a quietly thinner row.
 *
 * NO DATABASE AND NO NETWORK. The schema is a value; parsing it needs neither.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { translateAnswerSchema } from '../../cli/lib/schemas.ts';

/** One answered row, with the note under the caller's control. */
function row(lemma: string, note: string | null) {
  return { ...rowWithoutNote(lemma), note };
}

/**
 * The same row with no `note` key at all, which is what a server that stopped
 * sending the field would put on the wire.
 */
function rowWithoutNote(lemma: string) {
  return {
    translationId: '0e0b760c-7079-48de-80fd-866764c24b4c',
    lemma,
    pos: 'noun',
    confidence: 0.9,
    generated: true,
    up: 0,
    down: 0,
    myVote: null,
  };
}

/** One `ready` answer over the given rows, shaped the way the endpoint answers. */
function answer(rows: readonly unknown[]) {
  return {
    q: 'Schneebesen',
    from: 'de',
    to: 'tr',
    kind: 'word',
    headwordId: '19a9432d-c7ba-4e9f-b78b-bfc8906367b9',
    panel: { state: 'ready', translations: rows },
  };
}

describe('the CLI translate answer schema', () => {
  it('keeps the usage note on a word-branch row', () => {
    const parsed = translateAnswerSchema.parse(
      answer([row('çırpma teli', 'Klassisches manuelles Küchengerät aus Drahtschlaufen.')]),
    );

    assert.equal(parsed.panel.state, 'ready');
    if (parsed.panel.state !== 'ready') return;
    assert.equal(parsed.panel.translations[0]?.note, 'Klassisches manuelles Küchengerät aus Drahtschlaufen.');
  });

  it('accepts a null note, which is what the phrase branch always sends', () => {
    const parsed = translateAnswerSchema.parse(answer([row('Kar teli nerede?', null)]));

    assert.equal(parsed.panel.state, 'ready');
    if (parsed.panel.state !== 'ready') return;
    assert.equal(parsed.panel.translations[0]?.note, null);
  });

  it('refuses a row with no note key at all, so a server that drops it is loud', () => {
    assert.throws(() => translateAnswerSchema.parse(answer([rowWithoutNote('çırpıcı')])));
  });
});
