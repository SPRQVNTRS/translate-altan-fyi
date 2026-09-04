/**
 * voice-input.tsx, speaking a query instead of typing it.
 *
 * NOTHING LEAVES THE DEVICE ON THE WEB SPEECH PATH. The browser's own
 * recogniser does the work, so there is no audio upload and no transcript
 * upload. That is the whole reason the browser path exists beside the server
 * fallback.
 *
 * THE SERVER FALLBACK IS THE OTHER HALF, AND IT IS A DIFFERENT BARGAIN. A
 * browser with no recogniser, which today means Firefox, records a short clip
 * and sends it to `/api/v1/transcribe`, where a model writes the words down.
 * That is a real upload and the reader is told so before they press anything.
 * The request itself lives in `app/lib/voice/recorder.ts`, never in this file:
 * the one place a recording is posted from is easier to keep honest than two.
 *
 * IT IS A GUESS, AND IT IS PRESENTED AS ONE. The recognised text is written
 * into the ordinary search box, where the reader can correct it, and the
 * ordinary search form submits it. There is no separate voice search: the words
 * travel the same normalisation, fuzzy match and did-you-mean path as anything
 * typed, because a recogniser mishears in the way a typist mistypes.
 *
 * SUPPORT IS DETECTED, NEVER SNIFFED. `SpeechRecognition` and its webkit
 * spelling are read off the global scope. A browser without either gets a
 * visible sentence saying so, never a missing control and never a dead button.
 *
 * WHY THE PIECES ARE SPLIT OUT. `startVoiceSession`, `createVoiceHandlers`,
 * `deliverTranscript` and `voiceStateForError` are exported and free of React.
 * There is no DOM library in this repo, so that split is what lets a unit test
 * drive a stubbed recogniser through the real code that writes the input and
 * submits the form, rather than through a copy of it written for the test.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Loader2, Mic, MicOff, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '#app/components/ui/button';
import { Label } from '#app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#app/components/ui/select';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
import {
  detectAudioRecorder,
  pickRecordingMimeType,
  postRecording,
  recorderScope,
  startRecording,
  TRANSCRIPTION_FAILED_KEY,
  type AudioRecorder,
  type AudioRecorderConstructor,
  type RecordingSession,
} from '#app/lib/voice/recorder';
import { cn } from '#app/lib/utils';

/* -------------------------------------------------------------------------- */
/* The Web Speech API, as much of it as this file uses                          */
/* -------------------------------------------------------------------------- */

/**
 * The shapes below are declared here rather than imported, because no shipped
 * TypeScript DOM library declares the `SpeechRecognition` object itself. They
 * are deliberately the MINIMUM this component touches: a narrow structural
 * type is also what a test can stub honestly.
 */

/** One reading of what was heard. */
export interface SpeechAlternative {
  readonly transcript: string;
}

/** One recognition match. Final once the recogniser stops revising it. */
export interface SpeechResult extends ArrayLike<SpeechAlternative> {
  readonly isFinal: boolean;
}

/** The `result` event: every match so far, interim ones included. */
export interface SpeechResultsEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResult>;
}

/** The `error` event. `error` carries the reason, for example `not-allowed`. */
export interface SpeechErrorEvent {
  readonly error: string;
}

/**
 * The recogniser object, as this component drives it.
 *
 * Events are subscribed with `addEventListener` rather than with the `on...`
 * properties. The recogniser is an `EventTarget` in every browser that has it,
 * and the listener form is the one the lint gate asks for.
 */
export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  addEventListener: SpeechRecognizerSubscribe;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

/** The three events this component listens for, and the shape each one carries. */
export interface SpeechRecognizerSubscribe {
  (type: 'result', listener: (event: SpeechResultsEvent) => void): void;
  (type: 'error', listener: (event: SpeechErrorEvent) => void): void;
  (type: 'end', listener: () => void): void;
}

/** How a recogniser is made. Both global spellings point at one of these. */
export type SpeechRecognizerConstructor = new () => SpeechRecognizer;

/**
 * The global object, as far as this file reads it.
 *
 * Both properties are OPTIONAL, which is the point: the absence of either one
 * is an ordinary value the code has to handle, not an error.
 */
export interface SpeechRecognitionScope {
  readonly SpeechRecognition?: SpeechRecognizerConstructor;
  readonly webkitSpeechRecognition?: SpeechRecognizerConstructor;
}

/** The global scope, typed for the two constructors this file looks for. */
export function speechRecognitionScope(): SpeechRecognitionScope {
  // SAFETY: `globalThis` is not typed with the Web Speech constructors by any
  // shipped DOM library, and both properties are optional on the target type,
  // so every read below is still guarded.
  return globalThis as SpeechRecognitionScope;
}

/**
 * The recogniser constructor this browser offers, or `null`.
 *
 * Feature detection, and nothing else. There is no user agent string, no
 * platform and no vendor read anywhere in this file: a browser that has the
 * object can use it, whatever it calls itself.
 */
export function detectSpeechRecognition(scope: SpeechRecognitionScope): SpeechRecognizerConstructor | null {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/* -------------------------------------------------------------------------- */
/* Languages                                                                    */
/* -------------------------------------------------------------------------- */

/** One spoken language offer: the dictionary code, the recogniser tag, the native name. */
export interface VoiceLanguage {
  code: LanguageCode;
  /** BCP-47, which is what the recogniser wants. */
  tag: string;
  /** Native name, never translated, so a reader can always find their own. */
  label: string;
}

/**
 * The four v1 languages, as recogniser tags.
 *
 * A region has to be chosen because BCP-47 recognisers want one, and a bare
 * `en` is refused by some engines. These are the widest-supported region for
 * each language, not a claim about the reader's accent.
 */
export const VOICE_LANGUAGES = [
  { code: 'en', tag: 'en-US', label: 'English' },
  { code: 'de', tag: 'de-DE', label: 'Deutsch' },
  { code: 'tr', tag: 'tr-TR', label: 'Türkçe' },
  { code: 'es', tag: 'es-ES', label: 'Español' },
] as const satisfies readonly VoiceLanguage[];

const VOICE_LANGUAGE_CODES: ReadonlySet<string> = new Set(VOICE_LANGUAGES.map((language) => language.code));

/** Whether a stored or a picked string is one of the four offered languages. */
export function isVoiceLanguage(value: string | null | undefined): value is LanguageCode {
  return value !== null && value !== undefined && VOICE_LANGUAGE_CODES.has(value);
}

/** The recogniser tag for a language code. Falls back to English, which is the reference. */
export function voiceLanguageTag(code: LanguageCode): string {
  return VOICE_LANGUAGES.find((language) => language.code === code)?.tag ?? 'en-US';
}

/** Where the last picked spoken language is remembered. Device-local, like the app language. */
export const VOICE_LANGUAGE_STORAGE_KEY = 'translate-voice-language';

/** CLIENT: the last spoken language this device picked. SSR-safe, and never throws. */
export function readStoredVoiceLanguage(): LanguageCode | null {
  if (globalThis.localStorage === undefined) return null;
  try {
    const raw = localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY);
    return isVoiceLanguage(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** CLIENT: remember the picked spoken language. Never throws (private mode, quota). */
export function writeStoredVoiceLanguage(code: LanguageCode): void {
  if (globalThis.localStorage === undefined) return;
  try {
    localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, code);
  } catch {
    /* storage blocked, the pick simply lasts for this visit */
  }
}

/* -------------------------------------------------------------------------- */
/* State                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the control is doing, as one closed set.
 *
 * `checking` is the first render, on the server and for the tick before the
 * effect has looked for the API. It is a real state rather than an assumption
 * either way: guessing "supported" flashes a button that may never work, and
 * guessing "unsupported" tells a supported browser a falsehood.
 */
export type VoiceState =
  | { kind: 'checking' }
  | { kind: 'idle' }
  | { kind: 'listening'; interim: string }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'failed' };

/** Reasons the browser gives when the reader, or the operating system, refused the microphone. */
const PERMISSION_REFUSALS: ReadonlySet<string> = new Set(['not-allowed', 'service-not-allowed']);

/**
 * The state a recogniser error lands in.
 *
 * A refused microphone is its own state, because it is the one failure the
 * reader can fix, and the message that fixes it is different from "try again".
 */
export function voiceStateForError(code: string): BrowserVoiceState {
  return PERMISSION_REFUSALS.has(code) ? { kind: 'denied' } : { kind: 'failed' };
}

/** How the component, or a test, is told to move to the next state. */
export type VoiceStateUpdater = (update: (previous: VoiceState) => VoiceState) => void;

/* -------------------------------------------------------------------------- */
/* The session                                                                  */
/* -------------------------------------------------------------------------- */

/** One recognised phrase, and whether the recogniser is still revising it. */
export interface VoiceTranscript {
  transcript: string;
  isFinal: boolean;
}

/** What a caller wants to know while a session runs. */
export interface VoiceSessionHandlers {
  onTranscript: (result: VoiceTranscript) => void;
  onError: (code: string) => void;
  onEnd: () => void;
}

/**
 * Everything heard so far, joined, plus whether it is settled.
 *
 * The event carries EVERY match of the session, not only the new one, so the
 * join is what makes a two-word phrase arrive whole rather than one word
 * replacing the other. Multi-word input is a milestone requirement.
 */
export function transcriptFromEvent(event: SpeechResultsEvent): VoiceTranscript {
  const parts: string[] = [];
  let isFinal = false;
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (!result) continue;
    const alternative = result[0];
    if (alternative) parts.push(alternative.transcript.trim());
    isFinal = result.isFinal;
  }
  return { transcript: parts.filter(Boolean).join(' '), isFinal };
}

/**
 * Start listening on an already-built recogniser.
 *
 * `continuous` is off: this is a lookup box, so one phrase ends the session.
 * `interimResults` is on, because watching the words appear is what tells the
 * reader the microphone is actually working.
 */
export function startVoiceSession(recognizer: SpeechRecognizer, tag: string, handlers: VoiceSessionHandlers): void {
  recognizer.lang = tag;
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  recognizer.addEventListener('result', (event) => handlers.onTranscript(transcriptFromEvent(event)));
  recognizer.addEventListener('error', (event) => handlers.onError(event.error));
  recognizer.addEventListener('end', () => handlers.onEnd());
  recognizer.start();
}

/** The part of the search box this component writes to. */
export interface TranscriptSink {
  value: string;
}

/** The part of the search form this component submits. */
export interface SubmittableForm {
  requestSubmit: () => void;
}

/** The search box and its form, as this component holds them. */
export interface SearchFormTargets {
  input: TranscriptSink | null;
  form: SubmittableForm | null;
}

/**
 * Put the recognised words in the search box, and submit once they settle.
 *
 * This is the whole integration with the rest of the screen. There is no
 * navigation and no request here: the form that a typist submits is the form
 * that submits, so the query inherits every bit of the ordinary search path.
 */
export function deliverTranscript(targets: SearchFormTargets, result: VoiceTranscript): void {
  if (targets.input) targets.input.value = result.transcript;
  if (result.isFinal) targets.form?.requestSubmit();
}

/**
 * The handlers a session runs with: they write the box, submit the form, and
 * move the visible state.
 *
 * A factory rather than four inline closures, so that the component and its
 * test drive one implementation. The state updates are FUNCTIONAL, because the
 * recogniser fires `error` and then `end`, and a plain assignment on `end`
 * would overwrite the refusal message the reader needs to see.
 */
export function createVoiceHandlers(targets: SearchFormTargets, updateState: VoiceStateUpdater): VoiceSessionHandlers {
  return {
    onTranscript: (result) => {
      deliverTranscript(targets, result);
      updateState((previous) => (previous.kind === 'listening' ? { kind: 'listening', interim: result.transcript } : previous));
    },
    onError: (code) => updateState(() => voiceStateForError(code)),
    onEnd: () => updateState((previous) => (previous.kind === 'listening' ? { kind: 'idle' } : previous)),
  };
}

/* -------------------------------------------------------------------------- */
/* The control                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The spoken language picker, shared by the on-device control and the server
 * fallback.
 *
 * One component rather than two copies: the two paths offer the SAME four
 * languages, and a list that drifted would make the fallback quietly narrower
 * than the control it replaces.
 */
export function VoiceLanguagePicker({
  language,
  onLanguageChange,
  triggerId,
}: {
  language: LanguageCode;
  onLanguageChange: (code: LanguageCode) => void;
  triggerId: string;
}) {
  const { t } = useTranslation();

  return (
    <>
      <Label htmlFor={triggerId} className="sr-only">
        {t('voice.fieldLabel')}
      </Label>
      <Select
        value={language}
        onValueChange={(next) => {
          // Radix hands back a plain string. Narrow it rather than assert it:
          // an unoffered code would be sent straight to the recogniser.
          if (isVoiceLanguage(next)) onLanguageChange(next);
        }}
      >
        <SelectTrigger id={triggerId} size="sm" className="w-32" aria-label={t('voice.fieldLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VOICE_LANGUAGES.map((option) => (
            <SelectItem key={option.code} value={option.code}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

/** Every state the ON-DEVICE control renders. `unsupported` is not one of them: see `VoiceControlProps`. */
export type BrowserVoiceState = Exclude<VoiceState, { kind: 'unsupported' }>;

/**
 * Everything the rendered control needs, and nothing it can decide for itself.
 *
 * `state` EXCLUDES `unsupported` on purpose. A browser with no recogniser gets
 * the server fallback below, not a variant of this control, and the narrowed
 * type is what makes that a compile error rather than a decision somebody has
 * to remember.
 */
export interface VoiceControlProps {
  state: BrowserVoiceState;
  language: LanguageCode;
  onLanguageChange: (code: LanguageCode) => void;
  onToggle: () => void;
  /**
   * Whether this control has already written words into the search box.
   *
   * It gates the best-effort note. That note is advice about a transcription,
   * and on a fresh page there is no transcription: it read as a second hint
   * under the input pane's own note, before the reader had touched anything.
   */
  hasTranscript: boolean;
  /** Ids for the picker label, so two controls on one screen cannot collide. */
  triggerId: string;
  className?: string;
}

/**
 * The rendered control, given a state.
 *
 * Deliberately free of effects and of feature detection: everything it shows is
 * an argument. That is what lets a unit test render the unsupported branch and
 * the refused-microphone branch without a browser.
 */
export function VoiceControl({
  state,
  language,
  onLanguageChange,
  onToggle,
  hasTranscript,
  triggerId,
  className,
}: VoiceControlProps) {
  const { t } = useTranslation();

  const isListening = state.kind === 'listening';
  const isChecking = state.kind === 'checking';
  // Nothing has gone wrong, so the line below is free to say what is happening.
  const isSpeaking = state.kind !== 'denied' && state.kind !== 'failed';
  const buttonLabel =
    isChecking ? t('voice.checking')
    : isListening ? t('voice.stop')
    : t('voice.start');

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <VoiceLanguagePicker language={language} onLanguageChange={onLanguageChange} triggerId={triggerId} />

        <Button
          type="button"
          variant={isListening ? 'default' : 'outline'}
          size="sm"
          onClick={onToggle}
          disabled={isChecking}
          aria-pressed={isListening}
        >
          {isListening ?
            <MicOff className="size-4" aria-hidden="true" />
          : <Mic className="size-4" aria-hidden="true" />}
          {buttonLabel}
        </Button>
      </div>

      {/* One line at a time, and it is always the most useful one: what went
          wrong if something did, otherwise what is happening now.

          THE BEST-EFFORT NOTE WAITS FOR A TRANSCRIPTION. It is advice about
          words a recogniser wrote, so on an untouched page it said nothing
          about anything, and it stacked a second hint under the input pane's
          own note on the first screen a reader ever sees. */}
      <output className="text-xs text-muted-foreground">
        {state.kind === 'denied' && t('voice.denied')}
        {state.kind === 'failed' && t('voice.failed')}
        {isSpeaking && isListening && t('voice.listening')}
        {isSpeaking && !isListening && hasTranscript && t('voice.bestEffort')}
      </output>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The server fallback                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the fallback is doing, as one closed set.
 *
 * `no-recorder` is the true dead end: a browser with neither a recogniser nor a
 * usable recorder can only be told to type. It is still a sentence on the
 * screen, never a missing control.
 */
export type ServerVoiceState =
  | { kind: 'ready' }
  | { kind: 'no-recorder' }
  | { kind: 'recording' }
  | { kind: 'sending' }
  | { kind: 'transcribed'; model: string; labelKey: string }
  | { kind: 'refused'; messageKey: string };

/** Everything the rendered fallback needs, and nothing it can decide for itself. */
export interface ServerVoiceControlProps {
  state: ServerVoiceState;
  language: LanguageCode;
  onLanguageChange: (code: LanguageCode) => void;
  onToggle: () => void;
  triggerId: string;
  className?: string;
}

/**
 * The rendered fallback, given a state.
 *
 * Free of effects, of feature detection and of any request, exactly like
 * `VoiceControl`, so a unit test can render every branch without a browser.
 *
 * THE UPLOAD IS DISCLOSED BEFORE IT HAPPENS. The first two lines say the
 * browser cannot recognise speech itself and that a recording will be sent
 * instead, and the note under the button says the clip is never stored. A
 * reader deciding whether to press the button is entitled to know all of that
 * before pressing it, not after.
 */
export function ServerVoiceControl({
  state,
  language,
  onLanguageChange,
  onToggle,
  triggerId,
  className,
}: ServerVoiceControlProps) {
  const { t } = useTranslation();

  const isRecording = state.kind === 'recording';
  const isSending = state.kind === 'sending';

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <MicOff className="size-3.5" aria-hidden="true" />
        <span>{t('voice.unsupported')}</span>
        {state.kind !== 'no-recorder' && <span>{t('voice.serverFallbackHint')}</span>}
      </p>

      {state.kind === 'no-recorder' && (
        <output className="text-xs text-muted-foreground">{t('voice.serverUnsupportedRecording')}</output>
      )}

      {state.kind !== 'no-recorder' && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <VoiceLanguagePicker language={language} onLanguageChange={onLanguageChange} triggerId={triggerId} />

            <Button
              type="button"
              variant={isRecording ? 'default' : 'outline'}
              size="sm"
              onClick={onToggle}
              disabled={isSending}
              aria-pressed={isRecording}
            >
              {isSending ?
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              : isRecording ?
                <Square className="size-4" aria-hidden="true" />
              : <Mic className="size-4" aria-hidden="true" />}
              {isRecording ? t('voice.serverStop') : t('voice.serverStart')}
            </Button>
          </div>

          {/* One line at a time, and it is always the most useful one. */}
          <output className="text-xs text-muted-foreground">
            {state.kind === 'recording' && t('voice.serverRecording')}
            {state.kind === 'sending' && t('voice.serverSending')}
            {state.kind === 'refused' && t(state.messageKey)}
            {(state.kind === 'ready' || state.kind === 'transcribed') && t('voice.serverPrivacy')}
          </output>

          {/* THE DISCLOSURE. A model wrote these words and the reader is told
              so, under the same catalogue key the enrichment panel uses. See
              `app/lib/ai-disclosure.ts`: this is EU AI Act Article 50, not
              decoration, and it must not be deleted. */}
          {state.kind === 'transcribed' && (
            <p className="text-xs text-muted-foreground">{t(state.labelKey, { model: state.model })}</p>
          )}
        </>
      )}
    </div>
  );
}

/** What the fallback needs from the screen around it. */
export interface ServerVoiceFallbackProps {
  inputRef: RefObject<TranscriptSink | null>;
  formRef: RefObject<HTMLFormElement | null>;
  language: LanguageCode;
  onLanguageChange: (code: LanguageCode) => void;
  triggerId: string;
  className?: string;
}

/**
 * Record a clip, send it, and put the words in the search box.
 *
 * THE MICROPHONE IS RELEASED THE MOMENT THE RECORDING ENDS, on every path
 * including the failed ones. A live track left open keeps the browser's
 * recording indicator lit, which reads as an app that is still listening.
 */
export function ServerVoiceFallback({
  inputRef,
  formRef,
  language,
  onLanguageChange,
  triggerId,
  className,
}: ServerVoiceFallbackProps) {
  const [state, setState] = useState<ServerVoiceState>({ kind: 'ready' });
  const constructorRef = useRef<AudioRecorderConstructor | null>(null);
  const mimeTypeRef = useRef<string | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);

  useEffect(() => {
    const recorderConstructor = detectAudioRecorder(recorderScope());
    const mimeType = recorderConstructor === null ? null : pickRecordingMimeType(recorderConstructor);
    constructorRef.current = recorderConstructor;
    mimeTypeRef.current = mimeType;
    // A recorder that can only encode formats the endpoint refuses is the same
    // dead end as no recorder at all, and it is better found here than after an
    // upload the reader waited for.
    if (recorderConstructor === null || mimeType === null) setState({ kind: 'no-recorder' });

    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const handleToggle = useCallback(() => {
    const running = sessionRef.current;
    if (running) {
      running.stop();
      return;
    }

    const recorderConstructor = constructorRef.current;
    const mimeType = mimeTypeRef.current;
    if (recorderConstructor === null || mimeType === null) return;

    const scope = recorderScope();
    const mediaDevices = scope.navigator?.mediaDevices;
    if (mediaDevices === undefined) {
      setState({ kind: 'no-recorder' });
      return;
    }

    // An async function inside the handler rather than a then-chain: memory
    // `project_oxlint_promise_always_return` records why the chain form is not
    // available here.
    const run = async (): Promise<void> => {
      let stream: MediaStream;
      try {
        stream = await mediaDevices.getUserMedia({ audio: true });
      } catch {
        // The one failure the reader can fix, and it gets the same sentence the
        // Web Speech path uses for it.
        setState({ kind: 'refused', messageKey: 'voice.denied' });
        return;
      }

      const recorder: AudioRecorder = new recorderConstructor(stream, { mimeType });
      const session = startRecording({
        recorder,
        releaseStream: () => {
          for (const track of stream.getTracks()) track.stop();
        },
      });
      sessionRef.current = session;
      setState({ kind: 'recording' });

      const clip = await session.clip;
      sessionRef.current = null;
      setState({ kind: 'sending' });

      const outcome = await postRecording({ clip, language });
      if (outcome.kind === 'refused') {
        setState({ kind: 'refused', messageKey: outcome.messageKey });
        return;
      }

      // The same delivery the Web Speech path uses: the words land in the
      // ordinary search box and the ordinary form submits them, so the query
      // travels the normal normalisation, fuzzy match and did-you-mean path.
      deliverTranscript({ input: inputRef.current, form: formRef.current }, { transcript: outcome.text, isFinal: true });
      setState({ kind: 'transcribed', model: outcome.model, labelKey: outcome.labelKey });
    };

    void run().catch(() => setState({ kind: 'refused', messageKey: TRANSCRIPTION_FAILED_KEY }));
  }, [formRef, inputRef, language]);

  return (
    <ServerVoiceControl
      state={state}
      language={language}
      onLanguageChange={onLanguageChange}
      onToggle={handleToggle}
      triggerId={triggerId}
      className={className}
    />
  );
}

/**
 * What the search screen hands the voice control.
 *
 * `inputRef` is typed as a `TranscriptSink`, not as an `HTMLInputElement`,
 * because writing `.value` is the only thing this component ever does with it.
 * The narrower DOM type was a false constraint: the search box is a
 * `<textarea>` now, and both elements are exactly as much of a sink as each
 * other. The widening is deliberate and it keeps the contract honest, since a
 * reader of the type can see that nothing here reaches for an input's
 * selection, its validity or its files.
 */
export interface VoiceInputProps {
  /** The search box the recognised words are written into. */
  inputRef: RefObject<TranscriptSink | null>;
  /** The search form a settled phrase submits. */
  formRef: RefObject<HTMLFormElement | null>;
  /** The language the reader is looking a word up FROM, the best guess at what they will say. */
  sourceLanguage: LanguageCode;
  /** The id the picker's label binds to. */
  triggerId?: string;
  className?: string;
}

/**
 * The microphone beside the search box.
 *
 * The feature check runs in an EFFECT, not during render, so the server and the
 * first client render agree. The one frame in `checking` is the price of not
 * lying to either of them.
 */
export function VoiceInput({
  inputRef,
  formRef,
  sourceLanguage,
  triggerId = 'voice-language',
  className,
}: VoiceInputProps) {
  const [state, setState] = useState<VoiceState>({ kind: 'checking' });
  const [language, setLanguage] = useState<LanguageCode>(sourceLanguage);
  // Whether this control has ever written into the box. It survives the end of
  // a session, which `state` does not: the state returns to `idle` and the
  // words stay in the box, so the note about them has to outlast the session.
  const [hasTranscript, setHasTranscript] = useState(false);
  const constructorRef = useRef<SpeechRecognizerConstructor | null>(null);
  const recognizerRef = useRef<SpeechRecognizer | null>(null);

  useEffect(() => {
    const recognizerConstructor = detectSpeechRecognition(speechRecognitionScope());
    constructorRef.current = recognizerConstructor;
    setState(recognizerConstructor === null ? { kind: 'unsupported' } : { kind: 'idle' });

    // The reader's own last pick wins over the detected search direction: they
    // chose it, the direction was guessed for them.
    const remembered = readStoredVoiceLanguage();
    if (remembered) setLanguage(remembered);

    return () => {
      recognizerRef.current?.abort();
      recognizerRef.current = null;
    };
  }, []);

  const handleLanguageChange = useCallback((code: LanguageCode) => {
    setLanguage(code);
    writeStoredVoiceLanguage(code);
  }, []);

  const handleToggle = useCallback(() => {
    if (recognizerRef.current) {
      recognizerRef.current.stop();
      return;
    }
    const recognizerConstructor = constructorRef.current;
    if (recognizerConstructor === null) return;

    const recognizer = new recognizerConstructor();
    recognizerRef.current = recognizer;
    const handlers = createVoiceHandlers({ input: inputRef.current, form: formRef.current }, setState);
    setState({ kind: 'listening', interim: '' });
    startVoiceSession(recognizer, voiceLanguageTag(language), {
      ...handlers,
      onTranscript: (result) => {
        setHasTranscript(true);
        handlers.onTranscript(result);
      },
      onEnd: () => {
        recognizerRef.current = null;
        handlers.onEnd();
      },
      onError: (code) => {
        recognizerRef.current = null;
        handlers.onError(code);
      },
    });
  }, [formRef, inputRef, language]);

  // The two paths are different components, not two branches of one, because
  // they are different bargains: one keeps the audio on the device and the
  // other uploads it. The narrowed `BrowserVoiceState` makes this branch
  // compulsory rather than optional.
  if (state.kind === 'unsupported') {
    return (
      <ServerVoiceFallback
        inputRef={inputRef}
        formRef={formRef}
        language={language}
        onLanguageChange={handleLanguageChange}
        triggerId={triggerId}
        className={className}
      />
    );
  }

  return (
    <VoiceControl
      state={state}
      language={language}
      onLanguageChange={handleLanguageChange}
      onToggle={handleToggle}
      hasTranscript={hasTranscript}
      triggerId={triggerId}
      className={className}
    />
  );
}
