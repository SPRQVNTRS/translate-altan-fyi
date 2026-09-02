/**
 * transcribe.server.ts, a recorded clip in, a line of text out.
 *
 * THE AUDIO IS NEVER STORED. Not on disk, not in object storage, not in a
 * temporary directory, not in a log line. It exists as one `Uint8Array` handed
 * in by the route and as one base64 string on the way to the provider, and both
 * are unreachable the moment this function returns. That is the operator's
 * promise for this whole path, and this file is where it would be broken.
 *
 * THE TRANSCRIPT IS NOT A SEARCH RESULT. It goes back to the browser and lands
 * in the ordinary search box, so it travels the same normalisation, fuzzy match
 * and did-you-mean path as anything typed. Nothing here queries the dictionary.
 *
 * THIS FILE HAS NO DATABASE AND NO CLOCK. The rate limit and the daily budget
 * are the route's job, which is what lets a unit test drive this function
 * through a fake provider with no infrastructure at all.
 */

import { generatedByLabel, type GeneratedByLabel } from '#app/lib/ai-disclosure';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import { LlmCapabilityError, LlmNotConfiguredError, registry, type ActiveModel } from '#app/lib/llm/registry.server';
import { createComponentLogger } from '#app/lib/logger';
import { audioFormatForMimeType, type AudioFormat } from '#app/lib/voice/limits';

// The byte cap is re-exported rather than restated, so the route, the service
// and the browser all enforce one number. See `app/lib/voice/limits.ts` for why
// the constants live in a client-safe module.
export { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from '#app/lib/voice/limits';

const log = createComponentLogger('Transcribe');

/**
 * How long one transcription may take, in milliseconds.
 *
 * WELL UNDER UNDICI'S HIDDEN 300 SECOND CEILING, deliberately. Memory
 * `reference_node_fetch_hidden_300s_timeout` records what the default costs: a
 * request that hangs for five minutes while the reader has long since typed the
 * word instead. Sixty seconds is far past what a twenty second clip needs and
 * far short of a wait anybody would sit through.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/**
 * What one transcription reserves against the day's budget, in USD.
 *
 * A GENEROUS FLAT FIGURE, NOT A COMPUTED ONE. Audio is priced per second by
 * some providers and per token by others, and the request has to be reserved
 * before anyone knows which. An over-estimate is handed straight back by the
 * settle; an under-estimate lets a script past a cap it should have hit, so the
 * figure is set high on purpose. It is never zero: a zero reservation adds
 * nothing to the day's total, and a cap that sums zeroes never binds.
 */
export const TRANSCRIPTION_RESERVE_USD = 0.02;

/**
 * The longest transcript this path will return, in characters.
 *
 * A dictionary query is a word or a short phrase. A model that answers a twenty
 * second clip with three paragraphs has misunderstood the instruction, and the
 * search box is not the place to find that out, so the text is cut here.
 */
const MAX_TRANSCRIPT_CHARS = 200;

/** The spoken language names the instruction uses. English names, for the model, never for a reader. */
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  tr: 'Turkish',
  es: 'Spanish',
} satisfies Record<LanguageCode, string>;

/** One recording, as the route hands it over. */
export interface TranscriptionInput {
  /** The clip. Held in memory only, for the length of this call. */
  audio: Uint8Array;
  /** The upload's content type, which decides the container name the provider is told. */
  mimeType: string | null;
  /** The language the reader says they spoke. */
  language: LanguageCode;
  /** The operator's active model, read by the caller so this file needs no settings table. */
  active: ActiveModel;
}

/** Why a transcription produced no text. Each one is a different answer to the reader. */
export type TranscriptionFailure = 'unsupported-format' | 'empty-audio' | 'not-configured' | 'provider-failed';

/** What a transcription produced, as one union the route switches on. */
export type TranscriptionOutcome =
  | {
      ok: true;
      text: string;
      language: LanguageCode;
      generatedBy: GeneratedByLabel;
      /** The provider's own price for the call, or null when it reported none. */
      costUsd: number | null;
    }
  | { ok: false; reason: TranscriptionFailure };

/**
 * What the model is asked to do.
 *
 * VERBATIM, AND NOTHING ELSE. The answer goes straight into a search box, so a
 * model that helpfully explains, translates or punctuates the word has produced
 * a query nothing in the dictionary matches. The instruction names the language
 * the reader picked, because a bare "transcribe this" invites a model to guess
 * a language and to answer in it.
 */
export function transcriptionInstruction(language: LanguageCode): string {
  const name = LANGUAGE_NAMES[language];
  return [
    `Transcribe the speech in this audio clip verbatim in ${name}.`,
    'It is a single word or a short phrase that somebody is looking up in a dictionary.',
    'Return only the words that were spoken.',
    'Do not translate, do not explain, do not add punctuation that was not spoken, and do not add quotation marks.',
    'If you hear no speech at all, return an empty answer.',
  ].join(' ');
}

/**
 * Tidy a model's answer into something a search box can hold.
 *
 * Models wrap a short answer in quotation marks and in trailing full stops
 * often enough that leaving them in would send `"apfel."` to the dictionary and
 * find nothing. Newlines collapse for the same reason: an input has one line.
 */
export function cleanTranscript(raw: string): string {
  const collapsed = raw.replaceAll(/\s+/g, ' ').trim();
  const unquoted = collapsed.replace(/^["'«»„“”]+/, '').replace(/["'«»„“”]+$/, '');
  return unquoted.replace(/[.!?]+$/, '').trim().slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * Transcribe one recording.
 *
 * NEVER THROWS FOR AN EXPECTED FAILURE. Every way this can fail is a reader
 * sitting in front of a microphone who needs to be told to type instead, and a
 * 500 tells them nothing. An absent API key, a provider with no audio path and
 * a refused call are all ordinary outcomes here, and the route turns each into
 * a polite answer. A programming error still throws.
 *
 * @param input - the clip, its type, the spoken language and the active model.
 */
export async function transcribeRecording(input: TranscriptionInput): Promise<TranscriptionOutcome> {
  if (input.audio.byteLength === 0) return { ok: false, reason: 'empty-audio' };

  const format: AudioFormat | null = audioFormatForMimeType(input.mimeType);
  if (format === null) return { ok: false, reason: 'unsupported-format' };

  // The one copy of the clip that leaves this function. `Buffer.from` wraps the
  // array without copying it, and the base64 string is a local that dies with
  // this scope.
  const audioBase64 = Buffer.from(input.audio.buffer, input.audio.byteOffset, input.audio.byteLength).toString(
    'base64',
  );

  try {
    const result = await registry.transcribeAudio(input.active, {
      audioBase64,
      format,
      instruction: transcriptionInstruction(input.language),
      timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
    });

    const text = cleanTranscript(result.text);
    if (text === '') return { ok: false, reason: 'provider-failed' };

    // THE LOG LINE CARRIES NO WORDS. What was said is what the reader looked
    // up, and a log that records it is a search log wearing a different hat.
    // The model, the latency and the length are what an operator needs.
    log.info('Transcribed a recording', {
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      characters: text.length,
    });

    return {
      ok: true,
      text,
      language: input.language,
      generatedBy: generatedByLabel(result.model),
      costUsd: result.costUsd,
    };
  } catch (error) {
    if (error instanceof LlmNotConfiguredError || error instanceof LlmCapabilityError) {
      log.warn('Transcription is not available on this deployment', { reason: error.name });
      return { ok: false, reason: 'not-configured' };
    }
    log.warn('The transcription call failed', { reason: error instanceof Error ? error.message : 'unknown' });
    return { ok: false, reason: 'provider-failed' };
  }
}
