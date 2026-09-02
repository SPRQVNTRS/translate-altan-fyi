import type { Route } from './+types/api.v1.transcribe';
import { recordRejection, checkTriggerRateLimit } from '#app/lib/abuse/rate-limit.server';
import { release, reserve, settle } from '#app/lib/abuse/budget.server';
import { isServedLanguage, type LanguageCode } from '#app/lib/dictionary/detect-language';
import { registry } from '#app/lib/llm/registry.server';
import { createComponentLogger } from '#app/lib/logger';
import { audioFormatForMimeType, TRANSCRIBE_LANGUAGE_PARAM } from '#app/lib/voice/limits';
import { getActiveModel } from '#app/models/app-settings.server';
import {
  MAX_AUDIO_BYTES,
  TRANSCRIPTION_RESERVE_USD,
  transcribeRecording,
  type TranscriptionOutcome,
} from '#app/services/transcribe.server';

/**
 * `POST /api/v1/transcribe`, the server half of voice input.
 *
 * WHAT THIS ROUTE IS FOR.
 *   A browser with no Web Speech API records a short clip and posts it here.
 *   The clip goes to the active model, the words come back, and the browser
 *   puts them in the ordinary search box. Firefox is the reason this exists.
 *
 * THE CLIP IS NEVER STORED, ANYWHERE, BY ANYTHING.
 *   It arrives as a request body, becomes one buffer, and is unreachable the
 *   moment this function returns. There is no disk path, no bucket and no
 *   temporary file on this route, and the operator brief says so in as many
 *   words. Nothing may be added here that keeps the audio.
 *
 * IT IS FREE, AND FREE IS EXACTLY WHY IT IS GUARDED.
 *   There is no payment and no account gate on this route: anybody may speak a
 *   word. That makes it the cheapest way in the product to spend the operator's
 *   money, so it takes the SAME per-IP and per-session hourly limits as the
 *   enrichment trigger and it reserves against the SAME daily cap before the
 *   provider is called.
 *
 * A REFUSAL IS AN ANSWER, NOT AN ERROR.
 *   At the cap, with no key configured, or after a failed call, this route
 *   answers with a status and a catalogue key that tells the reader to type the
 *   word instead. It never answers 500 for any of those, because a person
 *   holding a microphone cannot act on a stack trace. Stage has no key at all,
 *   and it must still answer politely.
 *
 * NO ENGLISH PROSE REACHES THE BROWSER FROM HERE.
 *   `messageKey` is resolved against `app/locales/*` by the client, exactly as
 *   `api.enrichment-vote.ts` does it. `message` beside it is the plain
 *   developer-facing line an API client and a log reader see.
 *
 * THE ORDER OF THE GUARDS IS THE POINT.
 *   Cheapest and most certain first: a body too big is refused from a header
 *   before it is read, then the rate limit, then the body itself, then the
 *   provider configuration, and only then is money reserved. A request that is
 *   going to be turned away costs as little as possible on its way out.
 */

const log = createComponentLogger('TranscribeRoute');

/** Every way this route can answer, as one union the client switches on. */
export type TranscribeResponse =
  | {
      state: 'transcribed';
      text: string;
      language: LanguageCode;
      /** The EU AI Act Article 50 disclosure the client renders under the transcript. */
      generatedBy: { model: string; labelKey: string };
    }
  | { state: 'refused'; error: string; message: string; messageKey: string };

/**
 * The polite refusal.
 *
 * One shape for every declined request, so the client has a single branch and
 * cannot render a raw status code at a reader.
 */
function refuse(params: { status: number; error: string; message: string; messageKey: string }): Response {
  const body: TranscribeResponse = {
    state: 'refused',
    error: params.error,
    message: params.message,
    messageKey: params.messageKey,
  };
  return Response.json(body, { status: params.status });
}

/** The clip is over the cap. 413, and it is decided before anything is read. */
function refuseTooLarge(): Response {
  return refuse({
    status: 413,
    error: 'audio-too-large',
    message: `The recording is larger than the ${MAX_AUDIO_BYTES} byte limit`,
    messageKey: 'voice.serverTooLong',
  });
}

/** The service could not produce text. Each reason gets its own sentence for the reader. */
function refuseOutcome(reason: Exclude<TranscriptionOutcome, { ok: true }>['reason']): Response {
  if (reason === 'unsupported-format') {
    return refuse({
      status: 415,
      error: 'unsupported-format',
      message: 'The upload is not one of the audio formats this endpoint accepts',
      messageKey: 'voice.serverFailed',
    });
  }
  if (reason === 'empty-audio') {
    return refuse({
      status: 400,
      error: 'empty-audio',
      message: 'The upload carried no audio',
      messageKey: 'voice.serverNoSpeech',
    });
  }
  if (reason === 'not-configured') {
    // 503 rather than 500: the deployment is missing a provider key, which is
    // an operator state and not a fault in this request. Stage lands here.
    return refuse({
      status: 503,
      error: 'not-available',
      message: 'Server transcription is not configured on this deployment',
      messageKey: 'voice.serverUnavailable',
    });
  }
  return refuse({
    status: 503,
    error: 'transcription-failed',
    message: 'The provider did not return a transcript',
    messageKey: 'voice.serverFailed',
  });
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse({
      status: 405,
      error: 'method-not-allowed',
      message: 'This endpoint accepts POST only',
      messageKey: 'voice.serverFailed',
    });
  }

  // 1. THE FORMAT, FROM THE HEADER. A body we could not send to a provider
  //    anyway is refused before it is read off the socket.
  const contentType = request.headers.get('content-type');
  if (audioFormatForMimeType(contentType) === null) return refuseOutcome('unsupported-format');

  // 2. THE SIZE, ALSO FROM THE HEADER. This is the guard that keeps a large
  //    upload out of this process's memory entirely.
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) return refuseTooLarge();

  // 3. THE SHARED HOURLY LIMITS, the same two the enrichment trigger takes.
  const verdict = await checkTriggerRateLimit(request);
  if (!verdict.allowed) {
    return refuse({
      status: 429,
      error: 'rate-limited',
      message: 'Too many voice requests from this address or session in the last hour',
      messageKey: 'voice.serverBusy',
    });
  }

  // 4. THE BODY. It becomes one array in memory and is never written down.
  //    The header can lie, so the real length is checked again here.
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_AUDIO_BYTES) return refuseTooLarge();
  if (audio.byteLength === 0) return refuseOutcome('empty-audio');

  const url = new URL(request.url);
  const requestedLanguage = url.searchParams.get(TRANSCRIBE_LANGUAGE_PARAM);
  const language: LanguageCode = isServedLanguage(requestedLanguage) ? requestedLanguage : 'en';

  // 5. IS THERE A PROVIDER AT ALL? Asked BEFORE the reservation, so a
  //    deployment with no key never books spend it cannot use. The registry is
  //    the only thing in this app that knows what a provider key is called.
  const active = await getActiveModel();
  const status = registry.describeConfiguration(active);
  if (!status.configured) {
    log.info('Transcription declined, no provider is configured', { reason: status.reason });
    return refuseOutcome('not-configured');
  }

  // 6. RESERVE BEFORE THE CALL, ALWAYS. Counting afterwards has a window in
  //    which every parallel request reads the same low total and every one of
  //    them charges. See `app/lib/abuse/budget.server.ts`.
  const reservation = await reserve(TRANSCRIPTION_RESERVE_USD);
  if (!reservation.ok) {
    await recordRejection('budget');
    log.info('Transcription refused by the daily budget cap', { capUsd: reservation.capUsd });
    return refuse({
      status: 429,
      error: 'budget-exhausted',
      message: 'The daily transcription budget for this installation is used up',
      messageKey: 'voice.serverBudget',
    });
  }

  const outcome = await transcribeRecording({ audio, mimeType: contentType, language, active });

  if (!outcome.ok) {
    // NOTHING WAS SPENT WHEN THE PROVIDER WAS NEVER REACHED, so the reservation
    // goes back. `provider-failed` is the one reason that can mean a call did
    // run, so it settles at the estimate instead: releasing a call that burned
    // money would hand out a free retry loop, which is the one failure mode a
    // spend cap must not have.
    if (outcome.reason === 'provider-failed') {
      await settle({ estimateUsd: TRANSCRIPTION_RESERVE_USD, actualUsd: TRANSCRIPTION_RESERVE_USD });
    } else {
      await release(TRANSCRIPTION_RESERVE_USD);
    }
    return refuseOutcome(outcome.reason);
  }

  // A NULL COST SETTLES AT THE ESTIMATE, NEVER AT ZERO. The call cost money
  // whatever the provider chose to report, and settling those at zero would give
  // exactly the models we cannot price an unlimited number of free retries.
  await settle({ estimateUsd: TRANSCRIPTION_RESERVE_USD, actualUsd: outcome.costUsd ?? TRANSCRIPTION_RESERVE_USD });

  const body: TranscribeResponse = {
    state: 'transcribed',
    text: outcome.text,
    language: outcome.language,
    generatedBy: outcome.generatedBy,
  };
  return Response.json(body);
}
