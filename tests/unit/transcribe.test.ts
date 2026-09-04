/**
 * The transcription service, driven by a fake provider.
 *
 * NO NETWORK, NO DATABASE, NO CLOCK. `app/services/transcribe.server.ts` was
 * split from the route precisely so that this file needs none of them: the
 * provider is replaced through the registry's own audio seam, and everything
 * else the service touches is an argument.
 *
 * WHAT IS ACTUALLY BEING HELD IN PLACE HERE
 *   1. THE ANSWER GOES INTO A SEARCH BOX. A model that returns `"Apfel."` with
 *      quotation marks and a full stop has produced a query the dictionary does
 *      not contain. The cleaning is not cosmetic, it is what makes the fallback
 *      find anything.
 *   2. AN EXPECTED FAILURE IS NEVER A THROW. A missing key, a provider with no
 *      audio path and a refused call all reach a reader holding a microphone,
 *      and each one has to become a polite outcome the route can turn into a
 *      sentence. A throw here would be a 500 on the reader's screen.
 *   3. THE PROVIDER IS NOT CALLED FOR A REQUEST THAT CANNOT SUCCEED. An
 *      unsupported container and an empty body are refused before any call, and
 *      the fake counts calls so that "refused" cannot quietly mean "called and
 *      then refused".
 *   4. THE DISCLOSURE NAMES THE MODEL THAT RAN. EU AI Act Article 50, under the
 *      same catalogue key the enrichment panel uses.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ACTIVE_MODEL } from '#app/lib/llm/catalog';
import { registry, type AudioPort, type AudioTranscriptionRequest } from '#app/lib/llm/registry.server';
import { GENERATED_BY_LABEL_KEY } from '#app/lib/ai-disclosure';
import { requiresBearerToken } from '#app/lib/api-middleware.server';
import { TRANSCRIBE_PATH } from '#app/lib/voice/limits';
import { cleanTranscript, transcribeRecording, transcriptionInstruction } from '#app/services/transcribe.server';

/** A clip, as far as this service is concerned: some bytes and a content type. */
const CLIP = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** The key the registry looks for. A string, never a real credential: no call leaves this process. */
const FAKE_KEY = 'test-key-not-a-credential';

/** What the environment held before this file touched it. */
let previousKey: string | undefined;

/** A provider that answers whatever the test tells it to, and counts how often it was asked. */
function fakePort(answer: () => Promise<{ text: string; costUsd: number | null }>): AudioPort & {
  calls: AudioTranscriptionRequest[];
} {
  const calls: AudioTranscriptionRequest[] = [];
  return {
    calls,
    async transcribe(request) {
      calls.push(request);
      return answer();
    },
  };
}

before(() => {
  previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
});

afterEach(() => {
  registry.withAudioPort(null);
});

after(() => {
  registry.withAudioPort(null);
  if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousKey;
});

describe('transcription with a fake provider', () => {
  it('returns the words the provider heard', async () => {
    const port = fakePort(async () => ({ text: 'Apfelbaum', costUsd: 0.004 }));
    registry.withAudioPort(port);

    const outcome = await transcribeRecording({
      audio: CLIP,
      mimeType: 'audio/webm;codecs=opus',
      language: 'de',
      active: DEFAULT_ACTIVE_MODEL,
    });

    assert.equal(outcome.ok, true, 'a provider that answered must produce a transcript');
    assert.equal(outcome.text, 'Apfelbaum');
    assert.equal(outcome.language, 'de');
    assert.equal(outcome.costUsd, 0.004);
    assert.equal(port.calls.length, 1, 'exactly one provider call per request');
    assert.equal(port.calls[0]?.format, 'webm', 'the codec parameter must not reach the provider');
  });

  it('labels the transcript with the model that produced it', async () => {
    registry.withAudioPort(fakePort(async () => ({ text: 'elma', costUsd: null })));

    const outcome = await transcribeRecording({
      audio: CLIP,
      mimeType: 'audio/ogg',
      language: 'tr',
      active: DEFAULT_ACTIVE_MODEL,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.generatedBy.labelKey, GENERATED_BY_LABEL_KEY, 'the disclosure key is the shared one');
    assert.equal(outcome.generatedBy.model, DEFAULT_ACTIVE_MODEL.model, 'the sentence names the model that ran');
  });

  it('cleans a quoted, punctuated, multi-line answer into one query', () => {
    assert.equal(cleanTranscript('  "Apfel."  '), 'Apfel');
    assert.equal(cleanTranscript('guten\n  Morgen'), 'guten Morgen', 'a phrase stays whole');
    assert.equal(cleanTranscript('„Hund“'), 'Hund');
    assert.equal(cleanTranscript('   '), '');
  });

  it('asks for a verbatim transcript in the language the reader picked', () => {
    const instruction = transcriptionInstruction('es');
    assert.match(instruction, /Spanish/, 'the picked language is named');
    assert.match(instruction, /verbatim/i, 'the model is told not to interpret');
    assert.match(instruction, /Do not translate/i, 'a translation would be the wrong query');
  });
});

describe('transcription failures', () => {
  it('refuses a container it cannot send, before any provider call', async () => {
    const port = fakePort(async () => ({ text: 'never', costUsd: null }));
    registry.withAudioPort(port);

    const outcome = await transcribeRecording({
      audio: CLIP,
      mimeType: 'audio/aiff',
      language: 'en',
      active: DEFAULT_ACTIVE_MODEL,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'unsupported-format');
    assert.equal(port.calls.length, 0, 'a request that cannot succeed must cost nothing');
  });

  it('refuses an empty clip, before any provider call', async () => {
    const port = fakePort(async () => ({ text: 'never', costUsd: null }));
    registry.withAudioPort(port);

    const outcome = await transcribeRecording({
      audio: new Uint8Array(0),
      mimeType: 'audio/webm',
      language: 'en',
      active: DEFAULT_ACTIVE_MODEL,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'empty-audio');
    assert.equal(port.calls.length, 0);
  });

  it('reports a deployment with no provider key as not configured, never as an error', async () => {
    // The real path, with no injected port: the registry refuses before it
    // builds one. This is the state stage is in, and it must stay polite.
    registry.withAudioPort(null);
    delete process.env.OPENROUTER_API_KEY;

    const outcome = await transcribeRecording({
      audio: CLIP,
      mimeType: 'audio/webm',
      language: 'en',
      active: DEFAULT_ACTIVE_MODEL,
    });

    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'not-configured');
  });

  it('turns a refused provider call into an outcome, not a rejection', async () => {
    registry.withAudioPort(
      fakePort(async () => {
        throw new Error('the provider refused the transcription with status 429');
      }),
    );

    const outcome = await transcribeRecording({
      audio: CLIP,
      mimeType: 'audio/wav',
      language: 'en',
      active: DEFAULT_ACTIVE_MODEL,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'provider-failed');
  });

  it('treats an answer with no words in it as a failure, not as an empty query', async () => {
    registry.withAudioPort(fakePort(async () => ({ text: '  ...  ', costUsd: null })));

    const outcome = await transcribeRecording({
      audio: CLIP,
      mimeType: 'audio/webm',
      language: 'en',
      active: DEFAULT_ACTIVE_MODEL,
    });

    assert.equal(outcome.ok, false, 'an empty transcript must not be submitted as a search');
    assert.equal(outcome.reason, 'provider-failed');
  });
});

/* -------------------------------------------------------------------------- */
/* The Express guard in front of the route                                      */
/* -------------------------------------------------------------------------- */

/**
 * The bearer guard must let a recording through.
 *
 * WHY THIS CASE EXISTS. `app/lib/api-middleware.server.ts` answers 401 to every
 * `/api/v1/*` request with no `Authorization: Bearer` header, before the router
 * runs. The transcription route has no credential to send: its caller is a
 * browser with no Web Speech API. On 2026-09-02 a stage check found the guard
 * refusing every recording, and the route's own tests were all green, because
 * they call the action directly and never pass through Express. This case is
 * what closes that gap.
 */
describe('the api/v1 bearer guard and the voice fallback', () => {
  it('does not ask a recording for a token it cannot have', () => {
    assert.equal(
      requiresBearerToken(TRANSCRIBE_PATH),
      false,
      'the caller is a browser with no Web Speech API, and this product has no account requirement',
    );
  });

  it('still demands a token everywhere else under /api/v1/', () => {
    assert.equal(requiresBearerToken('/api/v1/api-keys'), true, 'the guard must still hold for API clients');
    assert.equal(requiresBearerToken('/api/v1/admin/db/tables'), true);
  });

  it('leaves the session-authenticated routes alone, as it did before', () => {
    assert.equal(requiresBearerToken('/api/v1/auth/login'), false);
    assert.equal(requiresBearerToken('/api/v1/sync/blob'), false);
  });
});
