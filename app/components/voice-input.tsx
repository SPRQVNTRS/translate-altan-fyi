/**
 * voice-input.tsx, speaking a query instead of typing it.
 *
 * NOTHING LEAVES THE DEVICE ON THIS PATH. The browser's own Web Speech API
 * does the recognition, so there is no audio upload, no transcript upload and
 * no request of any kind from this file. That is the whole reason the browser
 * path exists next to the server fallback that arrives later.
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
import { Mic, MicOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '#app/components/ui/button';
import { Label } from '#app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#app/components/ui/select';
import type { LanguageCode } from '#app/lib/dictionary/detect-language';
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
export function voiceStateForError(code: string): VoiceState {
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

/** Everything the rendered control needs, and nothing it can decide for itself. */
export interface VoiceControlProps {
  state: VoiceState;
  language: LanguageCode;
  onLanguageChange: (code: LanguageCode) => void;
  onToggle: () => void;
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
  triggerId,
  className,
}: VoiceControlProps) {
  const { t } = useTranslation();

  if (state.kind === 'unsupported') {
    return (
      <output className={cn('flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground', className)}>
        <MicOff className="size-3.5" aria-hidden="true" />
        <span>{t('voice.unsupported')}</span>
        <span>{t('voice.serverFallbackHint')}</span>
      </output>
    );
  }

  const isListening = state.kind === 'listening';
  const isChecking = state.kind === 'checking';
  const buttonLabel =
    isChecking ? t('voice.checking')
    : isListening ? t('voice.stop')
    : t('voice.start');

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
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
          wrong if something did, otherwise the honest note about how good
          browser recognition is. */}
      <output className="text-xs text-muted-foreground">
        {state.kind === 'denied' && t('voice.denied')}
        {state.kind === 'failed' && t('voice.failed')}
        {state.kind !== 'denied' && state.kind !== 'failed' && (isListening ? t('voice.listening') : t('voice.bestEffort'))}
      </output>
    </div>
  );
}

/** What the search screen hands the voice control. */
export interface VoiceInputProps {
  /** The search box the recognised words are written into. */
  inputRef: RefObject<HTMLInputElement | null>;
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

  return (
    <VoiceControl
      state={state}
      language={language}
      onLanguageChange={handleLanguageChange}
      onToggle={handleToggle}
      triggerId={triggerId}
      className={className}
    />
  );
}
