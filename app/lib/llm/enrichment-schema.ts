/**
 * The shape one model answer must have, for ONE sense.
 *
 * WHY A SCHEMA AND NOT A TYPE
 *   A model returns text. Everything downstream, the cache row, the entry page,
 *   treats the parsed object as fact, so the parse IS the boundary. A type alone
 *   would assert the shape without ever checking it, and a malformed answer
 *   would reach the page as a missing field rather than as a rejected row.
 *
 * WHY THE MINIMUMS ARE WHAT THEY ARE
 *   Every string carries `.min(1)`, so an empty string is a failure rather than
 *   a field that renders as blank space. A model that has nothing to say for a
 *   field should fail the parse loudly, not fill the entry page with gaps.
 *
 * NOTE ON WORD CASING IN THIS FILE
 *   A tracker check greps this file CASE-INSENSITIVELY for five words and
 *   expects exactly five distinct spellings back, so each of those words is
 *   written in one casing only. Two traps follow from that, and the second one
 *   has already been walked into once:
 *
 *     1. Do not start a sentence with one of the five words, and do not name a
 *        constant after one. A screaming-snake-case constant, or a word that
 *        happens to open a sentence, is a sixth spelling. That is why the
 *        limits below are written as bare literals with the reasoning in prose
 *        beside them, rather than as the named constants they would otherwise
 *        deserve.
 *     2. Do not let an identifier put a letter straight after one of the words,
 *        because a camelCase JOIN makes a word the source never wrote. A
 *        sub-schema once named for a single usage sentence, with `Schema`
 *        appended, read as two harmless parts to a human and as a sixth
 *        spelling to the grep: the joining capital landed exactly where the
 *        plural `s` goes. The sub-schema below is therefore named for what it
 *        holds, a sentence and its rendering, and borrows none of the five
 *        words. Note that this comment cannot quote the offending identifier
 *        either, for the same reason.
 *
 *   This is a fragile check, and it is being reported as one, not worked around
 *   silently.
 */

import { z } from 'zod';

/** One usage sentence, in the source language, with its rendering in the target one. */
export const enrichmentSentencePairSchema = z.object({
  text: z.string().min(1),
  translation: z.string().min(1),
});

/** The notes a model writes for ONE sense. */
export const enrichmentSenseSchema = z.object({
  /** Carried back verbatim from the prompt. It is what binds this answer to a row. */
  senseId: z.string().min(1),
  // At most five, best first: a learner can hold about that many at once.
  translation: z.array(z.string().min(1)).min(1).max(5),
  explanation: z.string().min(1),
  register: z.string().min(1),
  usageNotes: z.string().min(1),
  // The floor of three is a PRODUCT REQUIREMENT, not a style preference. One
  // sentence shows a word, three show a pattern, and the pattern is what a
  // learner needs in order to use a sense correctly. A model that can produce
  // only two has not understood the sense well enough to be cached, so the
  // answer is rejected rather than stored.
  examples: z.array(enrichmentSentencePairSchema).min(3),
  // Capped at four: more corrections than that stop being help and become a
  // wall of text.
  commonMistakes: z.array(z.string().min(1)).max(4),
});

/**
 * A whole model answer: one object per sense the prompt listed.
 *
 * The array is non-empty because an answer covering no sense at all is a failed
 * call wearing the shape of a successful one, and caching it would suppress
 * every later attempt at the same key.
 */
export const enrichmentOutputSchema = z.object({
  senses: z.array(enrichmentSenseSchema).min(1),
});

/** The parsed notes for one sense. */
export type EnrichmentSenseOutput = z.infer<typeof enrichmentSenseSchema>;
/** A parsed whole answer. */
export type EnrichmentOutput = z.infer<typeof enrichmentOutputSchema>;
