/**
 * The browser half of the server transcription fallback.
 *
 * WHY IT IS NOT IN THE COMPONENT. Two reasons, and both are load-bearing.
 * `app/components/voice-input.tsx` is checked to hold no request of its own, so
 * that the Web Speech path can never quietly start uploading; the one `fetch`
 * in the voice feature lives here instead, where it is obvious. And nothing
 * below needs React or a DOM, so a unit test can drive the real recording and
 * posting logic with plain objects.
 *
 * SUPPORT IS DETECTED, NEVER SNIFFED, exactly as on the Web Speech path. A
 * browser either has `MediaRecorder` and a microphone, or it does not.
 *
 * NOTHING HERE KEEPS THE CLIP. It is a `Blob` handed straight to `fetch` and
 * dropped. The microphone track is stopped as soon as the recorder stops, so
 * the browser's recording indicator goes out when the reader expects it to.
 */

import { z } from 'zod';

import {
  MAX_AUDIO_SECONDS,
  PREFERRED_RECORDING_MIME_TYPES,
  TRANSCRIBE_LANGUAGE_PARAM,
  TRANSCRIBE_PATH,
} from '#app/lib/voice/limits';

/* -------------------------------------------------------------------------- */
/* The recorder, as narrowly as this module uses it                             */
/* -------------------------------------------------------------------------- */

/** One chunk of encoded audio, as the recorder emits it. */
export interface RecordedChunk {
  readonly data: Blob;
}

/** The recorder object this module drives. A structural type, so a test can stub it honestly. */
export interface AudioRecorder {
  readonly mimeType: string;
  start: (timesliceMs?: number) => void;
  stop: () => void;
  addEventListener: AudioRecorderSubscribe;
}

/** The two events this module listens for. */
export interface AudioRecorderSubscribe {
  (type: 'dataavailable', listener: (event: RecordedChunk) => void): void;
  (type: 'stop', listener: () => void): void;
}

/** How a recorder is made, plus the static support probe that comes with it. */
export interface AudioRecorderConstructor {
  new (stream: MediaStream, options?: { mimeType?: string }): AudioRecorder;
  isTypeSupported?: (type: string) => boolean;
}

/** The global object, as far as this module reads it. Both members are optional on purpose. */
export interface RecorderScope {
  readonly MediaRecorder?: AudioRecorderConstructor;
  readonly navigator?: { readonly mediaDevices?: { getUserMedia: (constraints: { audio: true }) => Promise<MediaStream> } };
}

/** The global scope, typed for what this module looks for. */
export function recorderScope(): RecorderScope {
  // SAFETY: every member of the target type is optional, so each read below is
  // still guarded. `globalThis` is not typed with `MediaRecorder` on the server.
  return globalThis as RecorderScope;
}

/**
 * The recorder constructor this browser offers, or `null`.
 *
 * The microphone API is checked with it: a page served over plain HTTP has no
 * `mediaDevices`, and a recorder with nothing to record is a dead button.
 */
export function detectAudioRecorder(scope: RecorderScope): AudioRecorderConstructor | null {
  if (scope.MediaRecorder === undefined) return null;
  if (scope.navigator?.mediaDevices === undefined) return null;
  return scope.MediaRecorder;
}

/**
 * The first container this browser can encode that the server also accepts.
 *
 * Chrome answers webm, Firefox answers ogg, and Safari answers neither of those
 * two but does encode mp4. `null` means the browser records only formats the
 * transcription endpoint refuses, which is the same dead end as no recorder at
 * all and is reported as such rather than being discovered after an upload.
 */
export function pickRecordingMimeType(recorder: AudioRecorderConstructor): string | null {
  const isSupported = recorder.isTypeSupported;
  if (isSupported === undefined) return null;
  return PREFERRED_RECORDING_MIME_TYPES.find((type) => isSupported(type)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* The endpoint                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The two answers the route gives, decoded at the boundary.
 *
 * Parsed rather than trusted: this body crosses a network and is rendered to a
 * reader, and a shape that drifted would otherwise show `undefined` in the
 * search box.
 */
const transcribeResponseSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('transcribed'),
    text: z.string(),
    language: z.string(),
    generatedBy: z.object({ model: z.string(), labelKey: z.string() }),
  }),
  z.object({
    state: z.literal('refused'),
    error: z.string(),
    message: z.string(),
    messageKey: z.string(),
  }),
]);

/** What the caller does next: put words in the box, or show one sentence. */
export type TranscriptionClientOutcome =
  | { kind: 'transcribed'; text: string; model: string; labelKey: string }
  | { kind: 'refused'; messageKey: string };

/** The catalogue sentence for a request that never got an answer at all. */
export const TRANSCRIPTION_FAILED_KEY = 'voice.serverFailed';

/** What `postRecording` needs. `fetchImpl` is the test seam, and nothing else injects it. */
export interface PostRecordingParams {
  clip: Blob;
  language: string;
  fetchImpl?: typeof fetch;
}

/**
 * Post one clip and decode the answer.
 *
 * NEVER THROWS. A dropped connection, an HTML error page from a proxy and a
 * refusal from the route are all the same thing to a reader holding a
 * microphone: one sentence telling them what to do instead. The refusal already
 * carries that sentence's key, and everything else falls back to
 * `TRANSCRIPTION_FAILED_KEY`.
 *
 * The clip is sent as the raw body with its own content type. There is no
 * multipart envelope, because there is exactly one part and the server has to
 * be able to refuse an oversized body from its `Content-Length` alone.
 */
export async function postRecording(params: PostRecordingParams): Promise<TranscriptionClientOutcome> {
  const send = params.fetchImpl ?? fetch;
  const url = `${TRANSCRIBE_PATH}?${TRANSCRIBE_LANGUAGE_PARAM}=${encodeURIComponent(params.language)}`;

  try {
    const response = await send(url, {
      method: 'POST',
      headers: { 'Content-Type': params.clip.type },
      body: params.clip,
    });

    const parsed = transcribeResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { kind: 'refused', messageKey: TRANSCRIPTION_FAILED_KEY };
    if (parsed.data.state === 'refused') return { kind: 'refused', messageKey: parsed.data.messageKey };

    const text = parsed.data.text.trim();
    if (text === '') return { kind: 'refused', messageKey: 'voice.serverNoSpeech' };
    return {
      kind: 'transcribed',
      text,
      model: parsed.data.generatedBy.model,
      labelKey: parsed.data.generatedBy.labelKey,
    };
  } catch {
    return { kind: 'refused', messageKey: TRANSCRIPTION_FAILED_KEY };
  }
}

/* -------------------------------------------------------------------------- */
/* One recording                                                                */
/* -------------------------------------------------------------------------- */

/** A recording in progress: the way to end it early, and the clip it will produce. */
export interface RecordingSession {
  /** End the recording now. Calling it after it has already ended does nothing. */
  stop: () => void;
  /** The finished clip. It resolves when the recorder stops, however it stopped. */
  clip: Promise<Blob>;
}

/** What `startRecording` needs. The stream and the recorder are made by the caller. */
export interface StartRecordingParams {
  recorder: AudioRecorder;
  /** Stop the microphone track. Called exactly once, when the recording ends. */
  releaseStream: () => void;
  /** The ceiling, in milliseconds. Defaults to the shared duration cap. */
  maxMs?: number;
  /** The timer, injectable so a test needs no real clock. */
  scheduleStop?: (callback: () => void, delayMs: number) => () => void;
}

/** The cancel before a timer exists. It is a real function so no call site needs a null check. */
function noCancel(): void {
  /* nothing has been scheduled yet */
}

/** The default timer: `setTimeout`, and the cancel that goes with it. */
function defaultScheduleStop(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

/**
 * Record until the reader stops, or until the duration cap, whichever comes first.
 *
 * THE CAP IS ENFORCED HERE, IN THE BROWSER, and that is the FIRST of the two
 * guards. A clip that is never recorded is a request that is never made. The
 * server's byte cap is the second, because this one is editable by anyone with
 * a console open.
 */
export function startRecording(params: StartRecordingParams): RecordingSession {
  const chunks: Blob[] = [];
  const schedule = params.scheduleStop ?? defaultScheduleStop;
  let ended = false;
  // Assigned below, once the timer exists. It is declared up here because the
  // `stop` listener that calls it is subscribed before the timer is started.
  let cancelTimer: () => void = noCancel;

  const clip = new Promise<Blob>((resolve) => {
    params.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    params.recorder.addEventListener('stop', () => {
      ended = true;
      cancelTimer();
      params.releaseStream();
      resolve(new Blob(chunks, { type: params.recorder.mimeType }));
    });
  });

  const stop = (): void => {
    if (ended) return;
    params.recorder.stop();
  };

  cancelTimer = schedule(stop, params.maxMs ?? MAX_AUDIO_SECONDS * 1000);
  params.recorder.start();

  return { stop, clip };
}
