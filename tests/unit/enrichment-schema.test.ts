/**
 * The enrichment output schema is the boundary between a model's text and a
 * cached row, so these cases are about what it REFUSES.
 *
 * A schema that only ever sees well-formed input is untested. Each rejection
 * below stands for a real failure mode: too few sentences to teach a pattern,
 * an answer with no words in it, an answer that cannot be attached to a sense,
 * and a sentence with nothing to compare against.
 *
 * NO DATABASE AND NO NETWORK. Parsing is pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichmentOutputSchema,
  enrichmentSenseSchema,
} from '../../app/lib/llm/enrichment-schema';

const SENSE_ID = '11111111-2222-4333-8444-555555555555';

/** A payload that must parse, so every rejection below differs from it in ONE way. */
function wellFormedSense() {
  return {
    senseId: SENSE_ID,
    translation: ['laufen', 'rennen'],
    explanation: 'To move at a speed faster than walking.',
    register: 'Neutral, used in everyday speech.',
    usageNotes: 'Takes no preposition when used on its own.',
    examples: [
      { text: 'I run every morning.', translation: 'Ich laufe jeden Morgen.' },
      { text: 'She ran to the station.', translation: 'Sie rannte zum Bahnhof.' },
      { text: 'They run together on Sundays.', translation: 'Sie laufen sonntags zusammen.' },
    ],
    commonMistakes: ['Using the verb for a machine that is switched on.'],
  };
}

describe('enrichmentSenseSchema', () => {
  it('accepts a well-formed payload', () => {
    const parsed = enrichmentSenseSchema.parse(wellFormedSense());
    assert.equal(parsed.senseId, SENSE_ID);
    assert.equal(parsed.examples.length, 3);
  });

  it('rejects fewer than three examples', () => {
    const payload = wellFormedSense();
    payload.examples = payload.examples.slice(0, 2);
    assert.equal(enrichmentSenseSchema.safeParse(payload).success, false);
  });

  it('rejects an empty translation array', () => {
    const payload = wellFormedSense();
    payload.translation = [];
    assert.equal(enrichmentSenseSchema.safeParse(payload).success, false);
  });

  it('rejects a missing senseId', () => {
    const { senseId: _omitted, ...withoutSenseId } = wellFormedSense();
    assert.equal(enrichmentSenseSchema.safeParse(withoutSenseId).success, false);
  });

  it('rejects an example that carries no translation', () => {
    const payload = wellFormedSense();
    const [first, ...rest] = payload.examples;
    payload.examples = [{ text: first.text, translation: '' }, ...rest];
    assert.equal(enrichmentSenseSchema.safeParse(payload).success, false);
  });

  it('rejects more than five translations', () => {
    const payload = wellFormedSense();
    payload.translation = ['a', 'b', 'c', 'd', 'e', 'f'];
    assert.equal(enrichmentSenseSchema.safeParse(payload).success, false);
  });
});

describe('enrichmentOutputSchema', () => {
  it('accepts one sense', () => {
    const parsed = enrichmentOutputSchema.parse({ senses: [wellFormedSense()] });
    assert.equal(parsed.senses.length, 1);
  });

  it('rejects an answer that covers no sense at all', () => {
    assert.equal(enrichmentOutputSchema.safeParse({ senses: [] }).success, false);
  });
});
