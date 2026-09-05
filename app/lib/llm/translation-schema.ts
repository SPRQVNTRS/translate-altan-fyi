/**
 * The shape one model answer must have when it is asked to translate a headword.
 *
 * THERE ARE TWO SHAPES, AND THE CALLER CHOOSES.
 *   A headword that already carries senses is a solved problem on the source
 *   side: those senses are the dictionary's, they have ids, and the model's job
 *   is only to translate them. It is handed the ids and must carry each one back
 *   verbatim, and a `superRefine` rejects any id that was not offered. Inventing
 *   a sense would silently attach a translation to a meaning nobody asked about.
 *
 *   A headword with no senses at all is the case this whole feature exists for:
 *   about ninety three percent of the German headwords in this dictionary are in
 *   it, and a translation is a sense-to-sense edge, so with no sense there can be
 *   no translation, ever. There the model authors the senses too, and each one
 *   carries a `localId`, which is the model's own handle for a sense within one
 *   answer. It keeps the translations attached to the right sense and is never
 *   stored.
 *
 * THE CAPS LIVE IN THE SCHEMA, ON PURPOSE.
 *   An over-length answer is a FAILED run, not a silently trimmed one. Trimming
 *   would let the run report `ok` while the reader is shown a different set of
 *   senses than the one that was paid for, and the run row's `output` would then
 *   disagree with the rows in the dictionary. Rejecting is louder and cheaper.
 *
 * `pos` IS THE IMPORT'S OWN ENUM, NOT A FREE STRING.
 *   The part of speech is one third of the headword natural key. A model-authored
 *   headword carrying any other value lands outside the key every importer
 *   shares, so the same word would exist twice and neither copy could be found
 *   from the other. The values come from `app/lib/dictionary/pos.ts`, which the
 *   Wikidata importer derives its own type from.
 *
 * NO SERVER IMPORTS BELONG HERE. The pane reads the parsed shape, so this module
 * is reached by the client bundle.
 */

import { z } from 'zod';

import { POS_VALUES } from '#app/lib/dictionary/pos';
import { MAX_SENSES, MAX_TRANSLATIONS_PER_SENSE } from '#app/lib/translation/limits';

/**
 * How sure the model says it is.
 *
 * Three words rather than a number, because a model asked for 0.0 to 1.0 returns
 * a confident-looking decimal it cannot justify. The three levels map onto
 * `translations.confidence` at 0.9, 0.6 and 0.3 in the job; the mapping lives
 * there, beside the write, not here.
 */
export const translationConfidenceSchema = z.enum(['high', 'medium', 'low']);

/** How sure the model says it is about one translation. */
export type TranslationConfidence = z.infer<typeof translationConfidenceSchema>;

/** One word in the target language, as the model offers it. */
export const translationCandidateSchema = z.object({
  /**
   * The DICTIONARY FORM, which the prompt asks for in those words.
   *
   * It becomes `headwords.lemma`, and it is looked up against
   * `(language_code, lemma, pos)`. An inflected form written here would create a
   * second headword beside the imported one for the same word, unreachable from
   * it, and the dictionary would carry both forever.
   */
  lemma: z.string().min(1),
  pos: z.enum(POS_VALUES),
  /**
   * A one-word note on register, such as `formal` or `colloquial`.
   *
   * The one optional field in either shape. It is genuinely optional: most words
   * are register-neutral and a model forced to say something would invent a
   * distinction. Capped at thirty characters, because a model that starts
   * writing a sentence here has misread the field.
   */
  register: z.string().max(30).optional(),
  confidence: translationConfidenceSchema,
});

/** One translation candidate, parsed. */
export type TranslationCandidate = z.infer<typeof translationCandidateSchema>;

/** The translations of one sense. Non-empty: a sense with no translation is a wasted call. */
const translationsField = z.array(translationCandidateSchema).min(1).max(MAX_TRANSLATIONS_PER_SENSE);

/** One of the dictionary's existing senses, translated. */
export const translatedExistingSenseSchema = z.object({
  /** Carried back verbatim from the prompt. It is what binds this answer to a row. */
  senseId: z.string().min(1),
  translations: translationsField,
});

/** One sense the model authored, because the headword had none. */
export const authoredSenseSchema = z.object({
  /**
   * The model's own handle for this sense within this one answer.
   *
   * NEVER STORED. It exists so the answer is internally consistent and readable
   * in the run row's `output`; the sense's real identity is the uuid the database
   * assigns when the row is written.
   */
  localId: z.string().min(1),
  pos: z.enum(POS_VALUES),
  /** A short gloss IN THE SOURCE LANGUAGE. It becomes `sense_versions.gloss` at version 1. */
  gloss: z.string().min(1),
  translations: translationsField,
});

/** One authored sense, parsed. */
export type AuthoredSense = z.infer<typeof authoredSenseSchema>;

/** The answer when the model authored the senses. */
export const authoredTranslationAnswerSchema = z.object({
  senses: z.array(authoredSenseSchema).min(1).max(MAX_SENSES),
});

/** A parsed answer for a headword that had no senses. */
export type AuthoredTranslationAnswer = z.infer<typeof authoredTranslationAnswerSchema>;

/** The answer when the dictionary supplied the senses. */
export type ExistingSensesTranslationAnswer = { senses: z.infer<typeof translatedExistingSenseSchema>[] };

/**
 * The answer schema for a headword that ALREADY HAS SENSES.
 *
 * Built per call rather than declared once, because the set of acceptable sense
 * ids is the set that was offered in the prompt, and that changes per headword.
 * The `superRefine` is the whole point: without it a model that invents an id,
 * or hands back one from a headword it saw earlier in its context, would have its
 * answer written against a sense the reader never asked about.
 *
 * @param offeredSenseIds The sense ids the prompt listed. Must be non-empty; a
 *   caller with none of them wants `authoredTranslationAnswerSchema` instead.
 * @returns A schema that accepts exactly an answer over those ids.
 */
export function existingSensesAnswerSchema(offeredSenseIds: readonly string[]) {
  const offered = new Set(offeredSenseIds);
  return z.object({
    senses: z
      .array(translatedExistingSenseSchema)
      .min(1)
      .max(MAX_SENSES)
      .superRefine((senses, ctx) => {
        for (const [index, sense] of senses.entries()) {
          if (offered.has(sense.senseId)) continue;
          ctx.addIssue({
            code: 'custom',
            path: [index, 'senseId'],
            message:
              `The answer names sense ${sense.senseId}, which was not offered in the prompt. ` +
              `The senses offered were: ${[...offered].join(', ')}.`,
          });
        }
      }),
  });
}
