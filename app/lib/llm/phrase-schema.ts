/**
 * The shape one model answer must have when it is asked to translate a piece of
 * running text.
 *
 * ONE REQUIRED STRING, AND THERE IS DELIBERATELY NOTHING ELSE IN IT.
 *   A field is an invitation, and every field this object grew would be
 *   answered: an `alternatives` array would fill up, a `notes` field would
 *   produce a paragraph, a `confidence` would be guessed at. All of them cost
 *   output tokens on a call a reader is waiting on, and none of them is on the
 *   screen this feature builds. The product decision is that a phrase answer is
 *   one sentence; the schema is where that decision is enforceable rather than
 *   hoped for.
 *
 * `.min(1)` MATTERS. An empty string parses as a string, and an `ok` row
 *   carrying one would show the reader a blank answer with no way to tell it
 *   apart from a working one. Rejecting it ends the run `failed`, which offers
 *   a retry.
 *
 * THE FIELD IS REQUIRED, NOT OPTIONAL OR NULLABLE, because structured outputs
 *   demand every field be required, and because a missing translation is not a
 *   kind of answer here: it is a failed run.
 *
 * NO SERVER IMPORTS BELONG HERE. The pane reads the parsed shape, so this module
 * is reached by the client bundle.
 */

import { z } from 'zod';

/**
 * The longest answer that will be accepted, in characters.
 *
 * Generous against `PHRASE_MAX_CHARS`, because a translation can legitimately
 * be much longer than its source: German compounds unpack into Turkish clauses,
 * and an English idiom becomes a Spanish sentence. What the ceiling stops is a
 * model that ignored the prompt and wrote an essay, which is a failed run
 * rather than a long answer.
 */
export const MAX_PHRASE_ANSWER_CHARS = 2000;

/** The one answer shape a phrase run accepts. */
export const phraseAnswerSchema = z.object({
  /** The translation, in the target language, as one piece of text. */
  translation: z.string().min(1).max(MAX_PHRASE_ANSWER_CHARS),
});

/** A parsed phrase answer. */
export type PhraseAnswer = z.infer<typeof phraseAnswerSchema>;
