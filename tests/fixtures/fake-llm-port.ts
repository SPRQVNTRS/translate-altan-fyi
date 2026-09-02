/**
 * A fake `LlmPort`, for tests that must exercise the enrichment path without
 * reaching a provider.
 *
 * NO NETWORK, EVER. The port is the seam `registry.withProvider` installs, so a
 * test that installs this one cannot make a live call even by accident, and
 * cannot spend money by leaving a real key in the environment.
 *
 * THE RESPONSES ARE A QUEUE, NOT A SINGLE VALUE. The job under test retries once
 * on a rejection, so "the first attempt throws and the second succeeds" is a
 * behaviour a test has to be able to state. One entry is consumed per call, in
 * order.
 *
 * THE PROGRAMMED VALUE IS PARSED BY THE CALLER'S OWN SCHEMA, which is what keeps
 * this fake honest: a fixture that no longer matches `enrichmentOutputSchema`
 * fails the test that uses it instead of quietly feeding an impossible shape
 * into the code under test.
 */

import type { z } from 'zod';

import type { JsonValue } from '../../app/lib/json';
import type { LlmPort } from '../../app/lib/llm/registry.server';

/** What the port was asked for, recorded per call. */
export interface RecordedLlmCall {
  prompt: string;
  /** The schema the caller demanded its answer satisfy. */
  schema: z.ZodType;
  timeoutMs: number;
}

/** One programmed answer: a value to return, or an error to throw. */
export type FakeLlmResponse =
  | { kind: 'value'; value: JsonValue; costUsd: number | null }
  | { kind: 'error'; error: Error };

export interface FakeLlmPort extends LlmPort {
  /** Every call, in order. */
  readonly calls: RecordedLlmCall[];
  /** How many times the port was asked for an answer. */
  readonly callCount: number;
  /** Forget every call and replace the queue. */
  reset(next?: FakeLlmResponse[]): void;
}

/** Shorthand for the common case: one successful answer. */
export function llmValue(value: JsonValue, costUsd: number | null = null): FakeLlmResponse {
  return { kind: 'value', value, costUsd };
}

/** Shorthand for a rejection. */
export function llmError(message: string): FakeLlmResponse {
  return { kind: 'error', error: new Error(message) };
}

/**
 * Build a fake port programmed with `responses`.
 *
 * @param responses One entry per expected call, consumed in order. Running past
 *   the end throws a named error rather than returning something plausible: a
 *   test that made more calls than it programmed has found a real difference in
 *   behaviour, and it should say so.
 */
export function createFakeLlmPort(responses: FakeLlmResponse[] = []): FakeLlmPort {
  const calls: RecordedLlmCall[] = [];
  let queue = [...responses];
  let programmed = responses.length;

  return {
    calls,
    get callCount() {
      return calls.length;
    },
    reset(next: FakeLlmResponse[] = []) {
      calls.length = 0;
      queue = [...next];
      programmed = next.length;
    },
    async complete(request) {
      calls.push({ prompt: request.prompt, schema: request.schema, timeoutMs: request.timeoutMs });
      const response = queue.shift();
      if (!response) {
        throw new Error(
          `The fake LLM port was called ${calls.length} time(s) but only ${programmed} response(s) were programmed`,
        );
      }
      if (response.kind === 'error') throw response.error;
      return { output: request.schema.parse(response.value), costUsd: response.costUsd };
    },
  };
}
