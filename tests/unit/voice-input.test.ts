/**
 * The voice control, driven by a stubbed recogniser.
 *
 * There is no DOM library in this repo and none is added here. The component
 * is split so that everything load-bearing is reachable without one: the
 * recogniser is a plain object, the search box is an object with a `value`,
 * and the search form is an object with a `requestSubmit`. Every function
 * below is the one the component itself calls, so a passing test here is not a
 * test of a copy written for the test.
 *
 * The rendered branches go through `react-dom/server`, which needs no DOM, and
 * the assertions compare against the REAL English catalogue rather than
 * against a string retyped here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  createVoiceHandlers,
  deliverTranscript,
  detectSpeechRecognition,
  isVoiceLanguage,
  startVoiceSession,
  transcriptFromEvent,
  VOICE_LANGUAGES,
  ServerVoiceControl,
  VoiceControl,
  voiceLanguageTag,
  voiceStateForError,
  type SpeechErrorEvent,
  type SpeechRecognitionScope,
  type SpeechRecognizer,
  type SpeechResultsEvent,
  type ServerVoiceState,
  type VoiceState,
} from '#app/components/voice-input';
import enCommon from '#app/locales/en/common.json';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

/** Any of the three listeners the component subscribes, before it is narrowed by type. */
type SpeechListener = ((event: SpeechResultsEvent) => void) | ((event: SpeechErrorEvent) => void) | (() => void);

/**
 * A recogniser that hears exactly what the test tells it to.
 *
 * It implements the same narrow interface the component declares, so the wiring
 * under test is the real wiring: the three subscriptions, the language the
 * component sets, and the `error` then `end` order a browser actually fires.
 */
class StubRecognizer implements SpeechRecognizer {
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  starts = 0;
  stops = 0;
  aborts = 0;
  private onResult: ((event: SpeechResultsEvent) => void) | null = null;
  private onError: ((event: SpeechErrorEvent) => void) | null = null;
  private onEnd: (() => void) | null = null;

  addEventListener(type: 'result', listener: (event: SpeechResultsEvent) => void): void;
  addEventListener(type: 'error', listener: (event: SpeechErrorEvent) => void): void;
  addEventListener(type: 'end', listener: () => void): void;
  addEventListener(type: string, listener: SpeechListener): void {
    if (type === 'result') {
      // SAFETY: the overloads above are what every caller sees, so the compiler
      // has already paired this event name with this listener shape at the call
      // site. The implementation signature is the widened union TypeScript
      // requires, and this branch restores the pairing for `result`.
      this.onResult = listener as (event: SpeechResultsEvent) => void;
    }
    if (type === 'error') {
      // SAFETY: as above, the `error` overload pairs this name with this shape.
      this.onError = listener as (event: SpeechErrorEvent) => void;
    }
    if (type === 'end') {
      // SAFETY: as above, the `end` overload pairs this name with a bare callback.
      this.onEnd = listener as () => void;
    }
  }

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  abort(): void {
    this.aborts += 1;
  }

  /** One `result` event carrying every phrase heard so far, as a browser sends it. */
  hear(phrases: readonly string[], isFinal: boolean): void {
    const results: Record<number, { readonly length: number; readonly 0: { transcript: string }; isFinal: boolean }> =
      {};
    phrases.forEach((phrase, index) => {
      results[index] = { length: 1, 0: { transcript: phrase }, isFinal };
    });
    this.onResult?.({ resultIndex: 0, results: { length: phrases.length, ...results } });
  }

  /** The pair a refused microphone produces: the error, then the end of the session. */
  fail(code: string): void {
    this.onError?.({ error: code });
    this.onEnd?.();
  }

  /** The end of a session, as the browser fires it after a final result. */
  finish(): void {
    this.onEnd?.();
  }
}

/** A state cell shaped like React's setter, so the component's own updater runs here too. */
function stateCell(initial: VoiceState) {
  let current = initial;
  return {
    update: (next: (previous: VoiceState) => VoiceState) => {
      current = next(current);
    },
    read: () => current,
  };
}

/** The English catalogue in a bare i18next instance: no cookie detector, no singleton. */
function englishInstance() {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: enCommon } },
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
  });
  return instance;
}

/**
 * The control rendered in one state, as static markup.
 *
 * `hasTranscript` defaults to false, which is a fresh page: the control has
 * written nothing into the search box yet.
 */
function renderControl(state: VoiceState, hasTranscript = false): string {
  // The on-device control no longer accepts `unsupported`: that state is the
  // server fallback's, and `renderServerControl` below renders it.
  if (state.kind === 'unsupported') throw new Error('render the unsupported state through renderServerControl');

  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: englishInstance() },
      createElement(VoiceControl, {
        state,
        onToggle: () => undefined,
        hasTranscript,
      }),
    ),
  );
}

/**
 * The server fallback rendered in one state, as static markup.
 *
 * The fallback is what an unsupported browser gets since M173/02: not a message
 * with no control, but a record button that posts a clip to the server. It is a
 * separate component with its own state union, so it needs its own renderer.
 */
function renderServerControl(state: ServerVoiceState): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: englishInstance() },
      createElement(ServerVoiceControl, {
        state,
        onToggle: () => undefined,
      }),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Feature detection                                                            */
/* -------------------------------------------------------------------------- */

describe('voice input support detection', () => {
  it('offers the server fallback, not a dead end, when the browser is unsupported', () => {
    const scope: SpeechRecognitionScope = {};
    assert.equal(detectSpeechRecognition(scope), null);

    const markup = renderServerControl({ kind: 'ready' });
    assert.ok(markup.includes(enCommon.voice.unsupported), `the unsupported sentence is missing from: ${markup}`);
    assert.ok(markup.includes(enCommon.voice.serverFallbackHint), 'the fallback hint is missing');
    assert.ok(markup.includes(enCommon.voice.serverStart), 'the record button is missing');
    assert.ok(markup.includes(enCommon.voice.serverPrivacy), 'the reader must be told the clip is not stored');
  });

  it('tells an unsupported browser that cannot record either to type instead', () => {
    const markup = renderServerControl({ kind: 'no-recorder' });
    assert.ok(
      markup.includes(enCommon.voice.serverUnsupportedRecording),
      `the dead-end sentence is missing: ${markup}`,
    );
    assert.ok(!markup.includes('<button'), `a browser that cannot record must get no button, got: ${markup}`);
  });

  it('finds the plain constructor, the webkit constructor, and prefers the plain one', () => {
    const plain = class extends StubRecognizer {};
    const prefixed = class extends StubRecognizer {};

    assert.equal(detectSpeechRecognition({ webkitSpeechRecognition: prefixed }), prefixed);
    assert.equal(detectSpeechRecognition({ SpeechRecognition: plain }), plain);
    assert.equal(detectSpeechRecognition({ SpeechRecognition: plain, webkitSpeechRecognition: prefixed }), plain);
  });

  it('renders a control, not a message, once a constructor is present', () => {
    const markup = renderControl({ kind: 'idle' });
    assert.ok(markup.includes('<button'), 'a supported browser must get a button');
    assert.ok(!markup.includes(enCommon.voice.unsupported), 'a supported browser must not be told it is unsupported');
  });

  it('holds the best-effort note back until there is a transcription to be advised about', () => {
    // On a fresh page the input pane already carries its own note. A second
    // hint under it, about words nobody has spoken, is the one the reader has
    // no use for yet.
    const fresh = renderControl({ kind: 'idle' });
    assert.ok(!fresh.includes(enCommon.voice.bestEffort), `an untouched control showed the note: ${fresh}`);

    const afterSpeaking = renderControl({ kind: 'idle' }, true);
    assert.ok(
      afterSpeaking.includes(enCommon.voice.bestEffort),
      'a reader whose spoken words were just written into the box was never told they can edit them first',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Permission                                                                   */
/* -------------------------------------------------------------------------- */

describe('voice input permission handling', () => {
  it('shows the refusal message when the recogniser errors with not-allowed', () => {
    const cell = stateCell({ kind: 'listening', interim: '' });
    const recognizer = new StubRecognizer();
    startVoiceSession(recognizer, 'de-DE', createVoiceHandlers({ input: null, form: null }, cell.update));

    recognizer.fail('not-allowed');

    // The `end` event follows the error, and it must not overwrite the state
    // the reader has to see.
    assert.equal(cell.read().kind, 'denied');
    const markup = renderControl(cell.read());
    assert.ok(markup.includes(enCommon.voice.denied), `the refusal message is missing from: ${markup}`);
    assert.ok(!markup.includes(enCommon.voice.failed), 'a refusal must not read as a generic failure');
  });

  it('separates a refusal from every other recogniser error', () => {
    assert.equal(voiceStateForError('not-allowed').kind, 'denied');
    assert.equal(voiceStateForError('service-not-allowed').kind, 'denied');
    assert.equal(voiceStateForError('network').kind, 'failed');
    assert.equal(voiceStateForError('no-speech').kind, 'failed');

    const markup = renderControl(voiceStateForError('network'));
    assert.ok(markup.includes(enCommon.voice.failed), 'a network failure gets the generic message');
  });
});

/* -------------------------------------------------------------------------- */
/* The transcript                                                               */
/* -------------------------------------------------------------------------- */

describe('voice input transcripts', () => {
  it('writes an interim result into the search box without submitting', () => {
    const input = { value: '' };
    let submissions = 0;
    const form = { requestSubmit: () => (submissions += 1) };
    const cell = stateCell({ kind: 'listening', interim: '' });
    const recognizer = new StubRecognizer();

    startVoiceSession(recognizer, voiceLanguageTag('de'), createVoiceHandlers({ input, form }, cell.update));
    assert.equal(recognizer.lang, 'de-DE', 'the picked language reaches the recogniser');
    assert.equal(recognizer.interimResults, true, 'interim results are what stream into the box');
    assert.equal(recognizer.starts, 1);

    recognizer.hear(['Feier'], false);

    assert.equal(input.value, 'Feier');
    assert.equal(submissions, 0, 'an interim guess must never run a search');
    const state = cell.read();
    assert.equal(state.kind, 'listening');
    assert.equal(state.kind === 'listening' ? state.interim : '', 'Feier');
  });

  it('submits the search form once a final result arrives', () => {
    const input = { value: '' };
    let submissions = 0;
    const form = { requestSubmit: () => (submissions += 1) };
    const cell = stateCell({ kind: 'listening', interim: '' });
    const recognizer = new StubRecognizer();

    startVoiceSession(recognizer, 'en-US', createVoiceHandlers({ input, form }, cell.update));
    recognizer.hear(['Feier'], false);
    recognizer.hear(['Feierabend'], true);
    recognizer.finish();

    assert.equal(input.value, 'Feierabend', 'the settled words are what the form carries');
    assert.equal(submissions, 1, 'exactly one search runs');
    assert.equal(cell.read().kind, 'idle', 'the control returns to idle when the session ends');
  });

  it('keeps a multi-word phrase whole', () => {
    const event: SpeechResultsEvent = {
      resultIndex: 0,
      results: {
        length: 2,
        0: { length: 1, 0: { transcript: 'guten ' }, isFinal: true },
        1: { length: 1, 0: { transcript: ' Abend' }, isFinal: true },
      },
    };
    assert.deepEqual(transcriptFromEvent(event), { transcript: 'guten Abend', isFinal: true });
  });

  it('leaves the box and the form alone when the screen has not mounted them', () => {
    // The refs are null until the search screen is on the page. A transcript
    // arriving then must not throw, or the recogniser's own callback dies.
    deliverTranscript({ input: null, form: null }, { transcript: 'hola', isFinal: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Languages                                                                    */
/* -------------------------------------------------------------------------- */

describe('voice input languages', () => {
  it('offers the four v1 languages as BCP-47 recogniser tags', () => {
    assert.deepEqual(
      VOICE_LANGUAGES.map((language) => language.code),
      ['en', 'de', 'tr', 'es'],
    );
    assert.deepEqual(
      VOICE_LANGUAGES.map((language) => language.tag),
      ['en-US', 'de-DE', 'tr-TR', 'es-ES'],
    );
    for (const language of VOICE_LANGUAGES) {
      assert.equal(voiceLanguageTag(language.code), language.tag);
      assert.ok(isVoiceLanguage(language.code));
    }
  });

  it('refuses a code it does not offer, so nothing unoffered reaches the recogniser', () => {
    assert.equal(isVoiceLanguage('fr'), false);
    assert.equal(isVoiceLanguage(''), false);
    assert.equal(isVoiceLanguage(null), false);
  });
});
