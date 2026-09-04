/**
 * A spoken utterance still reaches the loader after the search box became a
 * `<textarea>`.
 *
 * WHAT THIS GUARDS. `VoiceInput` writes the recognised words into the search
 * box and then submits the search form. The two-pane relayout replaced the
 * single-line `<input>` with a `<textarea>`, and `VoiceInput`'s `inputRef`
 * prop was typed as `RefObject<HTMLTextAreaElement>`'s sibling,
 * `RefObject<HTMLInputElement>`, which a textarea ref cannot satisfy. The prop
 * was widened to the sink the component actually uses. Both halves of that are
 * checked here: the widening, at the type level, and the delivery, by running
 * the component's own functions against a textarea-shaped sink.
 *
 * THERE IS NO DOM LIBRARY IN THIS REPO and none is added here, which is
 * exactly why `voice-input.tsx` exports `startVoiceSession`,
 * `createVoiceHandlers` and `deliverTranscript` free of React. The recogniser
 * below is a plain object and the search box is an object with a `value`, so
 * the code exercised is the shipped code and not a retyping of it.
 *
 * THE LAST CASE READS THE ROUTE'S SOURCE, and does so on purpose. Whether the
 * ref handed to `VoiceInput` is the SAME ref attached to the textarea is a
 * question about one file's wiring, not about a type, and without a DOM there
 * is no way to mount the route and ask the browser. The assertions are scoped
 * to the elements they name rather than to the whole file, so a doc comment
 * mentioning `name="q"` cannot satisfy them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RefObject } from 'react';

import {
  createVoiceHandlers,
  deliverTranscript,
  startVoiceSession,
  type SpeechErrorEvent,
  type SpeechRecognizer,
  type SpeechResultsEvent,
  type VoiceInputProps,
  type VoiceState,
} from '#app/components/voice-input';

/**
 * The search SURFACE as text. Read once: three cases ask different questions of it.
 *
 * It is `SearchPanes` rather than `routes/search.tsx` since M186: the two-pane
 * markup, and with it the textarea, the form and the voice control, moved out of
 * the route into a component so a dev-only review page could render the same
 * surface without a session. The wiring this file pins is unchanged, so only the
 * file it is read from moves.
 */
const ROUTE_SOURCE = readFileSync(new URL('../../app/components/search-panes.tsx', import.meta.url), 'utf8');

/** Any of the three listeners the component subscribes, before it is narrowed by type. */
type SpeechListener = ((event: SpeechResultsEvent) => void) | ((event: SpeechErrorEvent) => void) | (() => void);

/** A recogniser that hears exactly what the test tells it to hear. */
class StubRecognizer implements SpeechRecognizer {
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  private onResult: ((event: SpeechResultsEvent) => void) | null = null;

  addEventListener(type: 'result', listener: (event: SpeechResultsEvent) => void): void;
  addEventListener(type: 'error', listener: (event: SpeechErrorEvent) => void): void;
  addEventListener(type: 'end', listener: () => void): void;
  addEventListener(type: string, listener: SpeechListener): void {
    if (type === 'result') {
      // SAFETY: the overloads above are what every caller sees, so the compiler
      // has already paired this event name with this listener shape at the call
      // site. This branch restores that pairing inside the implementation
      // signature, which TypeScript requires to be the widened union.
      this.onResult = listener as (event: SpeechResultsEvent) => void;
    }
  }

  start(): void {}
  stop(): void {}
  abort(): void {}

  /** Say something, the way a browser reports it: every match so far, final or not. */
  hear(transcript: string, isFinal: boolean): void {
    this.onResult?.({ resultIndex: 0, results: [{ isFinal, length: 1, 0: { transcript } }] });
  }
}

/**
 * The search box, with only what the component touches.
 *
 * A real `<textarea>` has a `value` string and nothing else is read here, so
 * this stands in for one exactly.
 */
function textareaSink() {
  return { value: '' };
}

/** The search form, counting the submissions it is asked for. */
function submittableForm() {
  const form = {
    submissions: 0,
    requestSubmit: (): void => {
      form.submissions += 1;
    },
  };
  return form;
}

describe('a spoken query submits the textarea search form', () => {
  it('accepts a textarea ref where the search screen hands one over', () => {
    const textareaRef: RefObject<HTMLTextAreaElement | null> = { current: null };
    // The assignment IS the assertion: it does not compile if `inputRef` goes
    // back to being an `HTMLInputElement` ref, which is the regression that
    // would break the voice path on the relaid-out screen.
    const inputRef: VoiceInputProps['inputRef'] = textareaRef;
    assert.equal(inputRef.current, null);
  });

  it('writes a final utterance into the textarea and submits once', () => {
    const input = textareaSink();
    const form = submittableForm();

    deliverTranscript({ input, form }, { transcript: 'guten Morgen', isFinal: true });

    assert.equal(input.value, 'guten Morgen');
    assert.equal(form.submissions, 1);
  });

  it('shows an interim utterance in the textarea without submitting it', () => {
    const input = textareaSink();
    const form = submittableForm();

    deliverTranscript({ input, form }, { transcript: 'guten', isFinal: false });

    assert.equal(input.value, 'guten');
    assert.equal(form.submissions, 0);
  });

  it('drives the whole session, recogniser to submitted form', () => {
    const input = textareaSink();
    const form = submittableForm();
    const recognizer = new StubRecognizer();
    const states: VoiceState[] = [];
    const handlers = createVoiceHandlers({ input, form }, (update) => {
      states.push(update({ kind: 'listening', interim: '' }));
    });

    startVoiceSession(recognizer, 'de-DE', handlers);
    recognizer.hear('guten', false);
    recognizer.hear('guten Morgen', true);

    assert.equal(recognizer.lang, 'de-DE');
    assert.equal(input.value, 'guten Morgen');
    assert.equal(form.submissions, 1);
    assert.deepEqual(states.at(-1), { kind: 'listening', interim: 'guten Morgen' });
  });

  it('keeps the route wiring the voice control depends on', () => {
    const textarea = /<Textarea\b[\s\S]*?\/>/.exec(ROUTE_SOURCE)?.[0];
    assert.ok(textarea, 'the search route no longer renders a <Textarea />');
    assert.match(textarea, /name="q"/);
    assert.match(textarea, /ref=\{inputRef\}/);

    const voiceInput = /<VoiceInput\b[\s\S]*?\/>/.exec(ROUTE_SOURCE)?.[0];
    assert.ok(voiceInput, 'the search route no longer renders a <VoiceInput />');
    assert.match(voiceInput, /inputRef=\{inputRef\}/);
    assert.match(voiceInput, /formRef=\{formRef\}/);

    const form = /<Form\b[^>]*>/.exec(ROUTE_SOURCE)?.[0];
    assert.ok(form, 'the search route no longer renders a <Form>');
    assert.match(form, /method="get"/);
    assert.match(form, /ref=\{formRef\}/);
  });
});
