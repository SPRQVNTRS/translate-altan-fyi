/**
 * The LLM registry: the capability gate, and the test seam that keeps it offline.
 *
 * WHY THIS FILE EXISTS
 *   The registry's job is to REFUSE an option the active provider cannot express,
 *   rather than drop it. A dropped option is the quiet failure this whole design
 *   is built against: the operator sets a value, the save succeeds, and the model
 *   runs as if the setting were never there. Nothing downstream can detect that,
 *   so the refusal has to be pinned here.
 *
 * NO DATABASE, NO NETWORK, NO LIVE API. The registry is reached only through the
 * injected `LlmPort`, and every case that could otherwise build a real client
 * either deletes the API key first or installs a fake. `process.env` is restored
 * in each `t.after`, so test order cannot leak a key from one case into the next.
 */
import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { PROVIDERS, PROVIDER_IDS, DEFAULT_ACTIVE_MODEL } from '../../app/lib/llm/catalog';
import {
  registry,
  LlmCapabilityError,
  LlmNotConfiguredError,
  type ActiveModel,
  type LlmPort,
  type LlmCompletionRequest,
} from '../../app/lib/llm/registry.server';

/** A value that is obviously not a real credential, and that no assertion may echo. */
const STUB_KEY = 'stub-key-not-a-real-credential';

const ENV_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

/**
 * Restore `process.env` and the injected port after a case, whatever it did.
 * Registered before the mutation, so an assertion failure still cleans up.
 */
function restoreAfter(t: TestContext): void {
  const saved = ENV_VARS.map((name) => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    registry.withProvider(null);
  });
}

describe('provider catalog', () => {
  it('holds exactly the four known providers, each with at least one model', () => {
    assert.deepEqual(Object.keys(PROVIDERS).toSorted(), [...PROVIDER_IDS].toSorted());
    for (const id of PROVIDER_IDS) {
      assert.ok(PROVIDERS[id].models.length > 0, `${id} has no models, so it cannot be selected`);
    }
  });
});

describe('configureActiveModel', () => {
  it('accepts the default model and routes Gemini over the OpenRouter transport', (t) => {
    restoreAfter(t);
    process.env.OPENROUTER_API_KEY = STUB_KEY;
    const configured = registry.configureActiveModel(DEFAULT_ACTIVE_MODEL);
    assert.equal(configured.provider, 'gemini');
    assert.equal(configured.model, 'google/gemini-3.8-flash');
    assert.equal(configured.transport, 'openrouter');
    assert.equal(configured.reasoningEffort, undefined);
  });

  it('refuses a temperature on every provider, because no client can transmit one', (t) => {
    restoreAfter(t);
    for (const name of ENV_VARS) process.env[name] = STUB_KEY;
    for (const id of PROVIDER_IDS) {
      const active: ActiveModel = {
        provider: id,
        model: PROVIDERS[id].models[0].id,
        options: { temperature: 0.2 },
      };
      assert.throws(
        () => registry.configureActiveModel(active),
        LlmCapabilityError,
        `${id} accepted a temperature, which would then be dropped silently`,
      );
    }
  });

  it("refuses a graded reasoning effort on Gemini, which honours only 'none'", (t) => {
    restoreAfter(t);
    process.env.OPENROUTER_API_KEY = STUB_KEY;
    assert.throws(
      () =>
        registry.configureActiveModel({
          provider: 'gemini',
          // Any catalog id for this provider proves the point; picked deliberately
          // NOT the default, so this case does not need editing every time the
          // default Gemini model rotates.
          model: 'google/gemini-3.5-flash-lite',
          options: { reasoningEffort: 'high' },
        }),
      LlmCapabilityError,
    );
  });

  it("accepts reasoningEffort 'none' on Gemini, which does reach the model", (t) => {
    restoreAfter(t);
    process.env.OPENROUTER_API_KEY = STUB_KEY;
    const configured = registry.configureActiveModel({
      provider: 'gemini',
      // Deliberately not the default model, for the same reason as above.
      model: 'google/gemini-3.5-flash-lite',
      options: { reasoningEffort: 'none' },
    });
    assert.equal(configured.reasoningEffort, 'none');
  });

  it("accepts reasoningEffort 'high' on OpenAI, which honours the graded levels", (t) => {
    restoreAfter(t);
    process.env.OPENAI_API_KEY = STUB_KEY;
    const configured = registry.configureActiveModel({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      options: { reasoningEffort: 'high' },
    });
    assert.equal(configured.transport, 'openai');
    assert.equal(configured.reasoningEffort, 'high');
  });
});

describe('a missing API key', () => {
  it('is reported by name, never by value, and blocks configuration', (t) => {
    restoreAfter(t);
    delete process.env.OPENROUTER_API_KEY;
    const status = registry.describeConfiguration(DEFAULT_ACTIVE_MODEL);
    assert.equal(status.configured, false);
    // Narrowed by the assertion above: the union's false arm is the one with a reason.
    const reason = status.configured ? '' : status.reason;
    assert.match(reason, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(reason, /stub-key/);
    let message = '';
    assert.throws(
      () => registry.configureActiveModel(DEFAULT_ACTIVE_MODEL),
      (error: Error) => {
        message = error.message;
        return error instanceof LlmNotConfiguredError;
      },
    );
    assert.match(message, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(message, /stub-key/);
  });
});

describe('the injected port', () => {
  it('answers complete, sees the prompt and the schema, and is removed by withProvider(null)', async (t) => {
    restoreAfter(t);
    process.env.OPENROUTER_API_KEY = STUB_KEY;
    const schema = z.object({ gloss: z.string() });
    const seen: LlmCompletionRequest<z.ZodType>[] = [];
    const fake: LlmPort = {
      async complete<T extends z.ZodType>(request: LlmCompletionRequest<T>) {
        seen.push(request);
        // SAFETY: the fixture is parsed by the very schema the caller supplied,
        // so the result is `z.infer<T>` by construction. The generic cannot say
        // that, because `ZodType`'s default output parameter is `unknown`.
        const output = request.schema.parse({ gloss: 'a fixture' }) as z.infer<T>;
        return { output, costUsd: 0.0012 };
      },
    };
    registry.withProvider(fake);

    const result = await registry.complete(DEFAULT_ACTIVE_MODEL, {
      prompt: 'define the word run',
      schema,
      timeoutMs: 1000,
    });

    assert.deepEqual(result.output, { gloss: 'a fixture' });
    assert.equal(result.costUsd, 0.0012);
    assert.ok(result.latencyMs >= 0, 'the call was not timed');
    assert.equal(result.provider, 'gemini');
    // Not pinning the default here: this case is about the port seeing the
    // prompt/schema and returning what it's given, so it echoes back whatever
    // DEFAULT_ACTIVE_MODEL configures rather than hardcoding a model id.
    assert.equal(result.model, DEFAULT_ACTIVE_MODEL.model);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt, 'define the word run');
    assert.equal(seen[0].schema, schema);

    // Restoring the real port cannot be asserted by calling it: the real port
    // dials a provider, and no test may do that. What CAN be pinned without a
    // network call is that the fake stops answering, so a later case does not
    // silently keep receiving fixtures from this one.
    registry.withProvider(null);
    delete process.env.OPENROUTER_API_KEY;
    await assert.rejects(
      registry.complete(DEFAULT_ACTIVE_MODEL, { prompt: 'again', schema, timeoutMs: 1000 }),
      LlmNotConfiguredError,
    );
    assert.equal(seen.length, 1, 'the fake answered after it was removed');
  });
});
