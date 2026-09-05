/**
 * The model answer schema for a translation run, in both of its shapes.
 *
 * WHY THE SHAPE IS WORTH PINNING
 *   What this schema accepts becomes ROWS IN THE SHARED DICTIONARY, permanently.
 *   There is no review step and no expiry, so the parse is the only thing
 *   standing between a model's answer and an entry every later reader is served.
 *   Three specific failures are guarded here, and each one has a different
 *   consequence:
 *
 *   A sense id the prompt never offered would attach a translation to a meaning
 *   nobody asked about, and the run would still report `ok`.
 *
 *   A part of speech outside the import's own five values would write a headword
 *   outside the natural key every importer shares, so the same word would exist
 *   twice and neither copy could be found from the other.
 *
 *   An over-length answer, if it were trimmed instead of rejected, would let the
 *   run's stored `output` disagree with the rows in the dictionary, and nothing
 *   downstream could tell which of the two was what was paid for.
 *
 * NO DATABASE, NO NETWORK. The schema module has no server import; it is reached
 * by the client bundle, which is itself part of why it may not have one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { POS_VALUES } from '../../app/lib/dictionary/pos';
import { authoredTranslationAnswerSchema, existingSensesAnswerSchema } from '../../app/lib/llm/translation-schema';
import { MAX_SENSES, MAX_TRANSLATIONS_PER_SENSE } from '../../app/lib/translation/limits';

const SENSE_A = '11111111-1111-4111-8111-111111111111';
const SENSE_B = '22222222-2222-4222-8222-222222222222';

/** One well-formed translation candidate. */
function candidate(lemma: string) {
  return { lemma, pos: 'verb', confidence: 'high' };
}

/** A well-formed answer over the two sense ids above. */
const OVER_GIVEN_SENSES = {
  senses: [
    { senseId: SENSE_A, translations: [candidate('devirmek')] },
    { senseId: SENSE_B, translations: [candidate('şaşırtmak'), candidate('altüst etmek')] },
  ],
};

/** A well-formed answer for a headword that had no senses at all. */
const AUTHORED = {
  senses: [
    {
      localId: 's1',
      pos: 'verb',
      gloss: 'etwas zum Umfallen bringen',
      translations: [candidate('devirmek')],
    },
  ],
};

describe('the answer schema for a headword that already has senses', () => {
  const schema = existingSensesAnswerSchema([SENSE_A, SENSE_B]);

  it('accepts an answer over exactly the offered sense ids', () => {
    const result = schema.safeParse(OVER_GIVEN_SENSES);
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(result.data?.senses[0]?.senseId, SENSE_A);
  });

  it('accepts an answer that covers only some of the offered senses', () => {
    // A model with nothing to say about one sense is not an error. Covering a
    // sense badly to fill a slot would be worse than leaving it uncovered.
    const result = schema.safeParse({ senses: [OVER_GIVEN_SENSES.senses[0]] });
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('rejects a sense id that was never offered', () => {
    const invented = '33333333-3333-4333-8333-333333333333';
    const result = schema.safeParse({ senses: [{ senseId: invented, translations: [candidate('x')] }] });
    assert.equal(result.success, false, 'an invented sense id was accepted');
    assert.match(
      JSON.stringify(result.error?.issues ?? []),
      /was not offered/,
      'the rejection did not say why the id was refused',
    );
  });

  it('rejects an id that is merely close to an offered one', () => {
    // The comparison is exact. A near miss is the case a `.includes` or a
    // prefix test would let through, and it would attach a paid-for answer to
    // the wrong row.
    const result = schema.safeParse({ senses: [{ senseId: `${SENSE_A} `, translations: [candidate('x')] }] });
    assert.equal(result.success, false, 'a sense id with trailing whitespace was accepted');
  });

  it('rejects a part of speech outside the import enum', () => {
    const result = schema.safeParse({
      senses: [{ senseId: SENSE_A, translations: [{ lemma: 'devirmek', pos: 'transitive verb', confidence: 'high' }] }],
    });
    assert.equal(result.success, false, 'a free-text part of speech was accepted');
  });

  it('rejects more senses than one run may write', () => {
    const senses = Array.from({ length: MAX_SENSES + 1 }, () => ({
      senseId: SENSE_A,
      translations: [candidate('devirmek')],
    }));
    assert.equal(existingSensesAnswerSchema([SENSE_A]).safeParse({ senses }).success, false);
  });

  it('rejects an empty answer, which is a failed call wearing a successful shape', () => {
    assert.equal(schema.safeParse({ senses: [] }).success, false);
  });
});

describe('the answer schema for a headword that has no senses', () => {
  it('accepts an authored sense with a gloss and a local id', () => {
    const result = authoredTranslationAnswerSchema.safeParse(AUTHORED);
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(result.data?.senses[0]?.localId, 's1');
  });

  it('rejects an authored sense with no gloss', () => {
    // The gloss is what the source-side `sense_versions` row will hold, and that
    // column is NOT NULL. An empty string would render as a meaning with no
    // wording rather than as a rejected answer.
    const result = authoredTranslationAnswerSchema.safeParse({
      senses: [{ ...AUTHORED.senses[0], gloss: '' }],
    });
    assert.equal(result.success, false, 'an empty gloss was accepted');
  });

  it('rejects an authored sense with no local id', () => {
    const { localId: _dropped, ...withoutLocalId } = AUTHORED.senses[0] ?? { localId: '' };
    assert.equal(authoredTranslationAnswerSchema.safeParse({ senses: [withoutLocalId] }).success, false);
  });

  it('rejects a part of speech outside the import enum', () => {
    const result = authoredTranslationAnswerSchema.safeParse({
      senses: [{ ...AUTHORED.senses[0], pos: 'Verb' }],
    });
    assert.equal(result.success, false, 'a differently cased part of speech was accepted');
  });

  it('accepts every value the import enum holds, and nothing else', () => {
    for (const pos of POS_VALUES) {
      const result = authoredTranslationAnswerSchema.safeParse({
        senses: [{ ...AUTHORED.senses[0], pos, translations: [{ lemma: 'x', pos, confidence: 'low' }] }],
      });
      assert.equal(result.success, true, `${pos} is in the import enum and was refused`);
    }
  });

  it('rejects more senses than one run may write', () => {
    const senses = Array.from({ length: MAX_SENSES + 1 }, (_value, index) => ({
      ...AUTHORED.senses[0],
      localId: `s${index}`,
    }));
    assert.equal(authoredTranslationAnswerSchema.safeParse({ senses }).success, false);
  });
});

describe('the translation candidates under one sense', () => {
  const schema = existingSensesAnswerSchema([SENSE_A]);

  function answerWith(translations: unknown[]) {
    return { senses: [{ senseId: SENSE_A, translations }] };
  }

  it('rejects a sense with no translation at all', () => {
    assert.equal(schema.safeParse(answerWith([])).success, false);
  });

  it('rejects more translations than one sense may carry', () => {
    const many = Array.from({ length: MAX_TRANSLATIONS_PER_SENSE + 1 }, (_value, index) => candidate(`lemma-${index}`));
    assert.equal(schema.safeParse(answerWith(many)).success, false, 'an over-length list was accepted');
    assert.equal(
      schema.safeParse(answerWith(many.slice(0, MAX_TRANSLATIONS_PER_SENSE))).success,
      true,
      'the cap itself was refused, so the boundary is off by one',
    );
  });

  it('rejects an empty lemma', () => {
    assert.equal(schema.safeParse(answerWith([{ lemma: '', pos: 'verb', confidence: 'high' }])).success, false);
  });

  it('accepts the three confidence words and refuses anything else', () => {
    for (const confidence of ['high', 'medium', 'low']) {
      assert.equal(schema.safeParse(answerWith([{ lemma: 'x', pos: 'verb', confidence }])).success, true);
    }
    assert.equal(schema.safeParse(answerWith([{ lemma: 'x', pos: 'verb', confidence: 'sure' }])).success, false);
    assert.equal(schema.safeParse(answerWith([{ lemma: 'x', pos: 'verb', confidence: 0.9 }])).success, false);
    assert.equal(schema.safeParse(answerWith([{ lemma: 'x', pos: 'verb' }])).success, false, 'confidence is required');
  });

  it('accepts a candidate with no usage note, which is the ordinary case', () => {
    // `note` is optional on purpose. A required note makes a model invent a
    // usage claim for a lone candidate with nothing to be distinguished from,
    // and an invented note reads as authoritative on the screen.
    assert.equal(schema.safeParse(answerWith([candidate('devirmek')])).success, true);
  });

  it('accepts a usage note that is one short sentence', () => {
    const note = 'Wird vor allem für Gegenstände verwendet, nicht für Personen.';
    assert.equal(
      schema.safeParse(answerWith([{ lemma: 'devirmek', pos: 'verb', note, confidence: 'high' }])).success,
      true,
    );
  });

  it('rejects a usage note longer than the cap', () => {
    // A note past a hundred and sixty characters has stopped distinguishing the
    // word and started defining it, which is what the gloss is for.
    const tooLong = 'a'.repeat(161);
    assert.equal(
      schema.safeParse(answerWith([{ lemma: 'devirmek', pos: 'verb', note: tooLong, confidence: 'high' }])).success,
      false,
      'a note of 161 characters was accepted',
    );
    assert.equal(
      schema.safeParse(answerWith([{ lemma: 'devirmek', pos: 'verb', note: 'a'.repeat(160), confidence: 'high' }]))
        .success,
      true,
      'the cap itself was refused, so the boundary is off by one',
    );
  });

  it('rejects an empty usage note', () => {
    // An empty string is not the same answer as leaving the field out: it would
    // be stored, and the screen would render a blank line under the word.
    assert.equal(
      schema.safeParse(answerWith([{ lemma: 'devirmek', pos: 'verb', note: '', confidence: 'high' }])).success,
      false,
      'an empty note was accepted',
    );
  });

  it('accepts a short register note and refuses a sentence', () => {
    assert.equal(
      schema.safeParse(answerWith([{ lemma: 'x', pos: 'verb', register: 'colloquial', confidence: 'high' }])).success,
      true,
    );
    assert.equal(
      schema.safeParse(
        answerWith([
          {
            lemma: 'x',
            pos: 'verb',
            register: 'this is a whole sentence about when a speaker would choose this word',
            confidence: 'high',
          },
        ]),
      ).success,
      false,
      'a model that started writing prose in the register field was accepted',
    );
  });
});
