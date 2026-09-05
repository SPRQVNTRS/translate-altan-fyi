/**
 * The mail transports and the way one of them is chosen.
 *
 * The pigeon transport is exercised against a STUBBED `fetch`, and the
 * assertions are on the request it builds: the URL, the three headers and the
 * body. That is the whole contract with the mail service, it is written by
 * hand in this repository rather than by a vendor SDK, and a typecheck cannot
 * see any of it.
 *
 * `fetch` is replaced on `globalThis` and restored afterwards rather than
 * mocked at the module level, which the anti-slop lint bans and which would
 * also hide the fact that the transport deliberately uses the global.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { EmailSendResult } from '../../../app/services/email.server';
import {
  MailError,
  createConsoleTransport,
  createMemoryTransport,
  createPigeonTransport,
  getDefaultTransport,
  sendMail,
  setTransportForTests,
} from '../../../app/services/email.server';

const API_KEY = 'ske_test_key';
const BASE_URL = 'http://mail.test:3601';
const LINK = 'https://kenning.altan.fyi/verify?token=abc123';

/** A message with the link in it, so the console assertions have something to find. */
const MESSAGE = {
  from: 'no-reply@kenning.altan.fyi',
  to: 'reader@example.com',
  subject: 'Confirm your email address',
  text: `Hello,\n\nOpen this link:\n\n${LINK}\n\nThank you.`,
};

/** One recorded call to the stubbed `fetch`. */
type RecordedCall = { url: string; init: RequestInit };

/** A scripted `fetch`, plus the calls it saw and the way back to the real one. */
type FetchStub = {
  calls: RecordedCall[];
  restore: () => void;
};

/** Replaces `globalThis.fetch` with a scripted answer and records every call. */
function stubFetch(answer: (call: number) => Promise<Response>): FetchStub {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answer(calls.length);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** The two answer shapes the mail service gives: a queued message, or a refusal. */
type ServiceBody = { id: string; status?: string } | { error: string };

function jsonResponse(body: ServiceBody, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Collects everything written to `console.log` for the duration of one call. */
async function captureLog(run: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map((arg) => String(arg)).join(' '));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

/**
 * Runs a send that must fail, and hands back the `MailError` it threw.
 *
 * A rejection is the whole assertion in four of these cases, so it is worth
 * one helper rather than four inline `then(null, ...)` pairs.
 */
async function captureMailError(run: () => Promise<EmailSendResult>): Promise<MailError> {
  try {
    await run();
  } catch (cause) {
    assert.ok(cause instanceof MailError, `expected a MailError, got ${String(cause)}`);
    return cause;
  }
  assert.fail('the send resolved, but it had to reject');
}

/** Reads the JSON body the transport sent, as an object with the fields under test. */
function sentBody(call: RecordedCall): { from: string; to: string[]; subject: string; text: string } {
  assert.ok(call.init.body !== undefined && call.init.body !== null, 'the request carried no body');
  return JSON.parse(String(call.init.body));
}

/** Reads one header off a recorded call. */
function sentHeader(call: RecordedCall, name: string): string | undefined {
  const headers = new Headers(call.init.headers);
  return headers.get(name) ?? undefined;
}

describe('memory transport', () => {
  it('records the message instead of sending it', async () => {
    const transport = createMemoryTransport();

    const result = await transport.send({ ...MESSAGE, idempotencyKey: 'verify-1' });

    assert.equal(transport.messages.length, 1);
    assert.equal(transport.messages[0]?.to, MESSAGE.to);
    assert.equal(transport.messages[0]?.subject, MESSAGE.subject);
    assert.equal(transport.messages[0]?.idempotencyKey, 'verify-1');
    assert.ok(transport.messages[0]?.sentAt instanceof Date);
    assert.equal(result.messageId, 'memory-1');

    transport.clear();
    assert.equal(transport.messages.length, 0);
  });
});

describe('console transport', () => {
  it('prints the whole body, so the link is reachable without a mail service', async () => {
    const transport = createConsoleTransport();

    const output = await captureLog(async () => {
      await transport.send(MESSAGE);
    });

    assert.ok(output.includes(LINK), 'the link is not in the console output');
    assert.ok(output.includes('[mail] no PIGEON_API_KEY set, printing instead of sending'));
    assert.ok(output.includes(MESSAGE.to));
    assert.ok(output.includes(MESSAGE.subject));
    assert.ok(output.includes('[mail] end of message'));
  });
});

describe('pigeon transport', () => {
  it('posts the documented request and returns the message id', async () => {
    const stub = stubFetch(async () => jsonResponse({ id: 'msg_123', status: 'queued' }));
    try {
      const result = await createPigeonTransport(API_KEY, BASE_URL).send({ ...MESSAGE, idempotencyKey: 'verify-1' });

      assert.equal(result.messageId, 'msg_123');
      assert.equal(stub.calls.length, 1);

      const call = stub.calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.url, 'http://mail.test:3601/v1/emails');
      assert.equal(call.init.method, 'POST');
      assert.equal(sentHeader(call, 'Authorization'), `Bearer ${API_KEY}`);
      assert.equal(sentHeader(call, 'Content-Type'), 'application/json');
      assert.equal(sentHeader(call, 'Idempotency-Key'), 'verify-1');
      assert.deepEqual(sentBody(call), {
        from: MESSAGE.from,
        to: [MESSAGE.to],
        subject: MESSAGE.subject,
        text: MESSAGE.text,
      });
    } finally {
      stub.restore();
    }
  });

  it('omits the idempotency header when the caller has no key', async () => {
    const stub = stubFetch(async () => jsonResponse({ id: 'msg_124' }));
    try {
      await createPigeonTransport(API_KEY, BASE_URL).send(MESSAGE);

      const call = stub.calls[0];
      assert.ok(call !== undefined);
      assert.equal(sentHeader(call, 'Idempotency-Key'), undefined);
    } finally {
      stub.restore();
    }
  });

  it('maps 429 to rate_limited and does not retry it', async () => {
    const stub = stubFetch(async () => jsonResponse({ error: 'too many' }, 429));
    try {
      const error = await captureMailError(() => createPigeonTransport(API_KEY, BASE_URL).send(MESSAGE));

      assert.equal(error.code, 'rate_limited');
      assert.equal(error.status, 429);
      assert.equal(stub.calls.length, 1, 'a refused message must not be sent twice');
    } finally {
      stub.restore();
    }
  });

  it('maps any other refusal to its status and does not retry it', async () => {
    const stub = stubFetch(async () => jsonResponse({ error: 'boom' }, 500));
    try {
      const error = await captureMailError(() => createPigeonTransport(API_KEY, BASE_URL).send(MESSAGE));

      assert.equal(error.code, 'http_500');
      assert.equal(error.status, 500);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  it('retries a dead network once, and succeeds on the second attempt', async () => {
    const stub = stubFetch(async (call) => {
      if (call === 1) throw new Error('connect ECONNREFUSED');
      return jsonResponse({ id: 'msg_retry' });
    });
    try {
      const result = await createPigeonTransport(API_KEY, BASE_URL).send(MESSAGE);

      assert.equal(result.messageId, 'msg_retry');
      assert.equal(stub.calls.length, 2);
    } finally {
      stub.restore();
    }
  });

  it('reports network_error when both attempts fail', async () => {
    const stub = stubFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    try {
      const error = await captureMailError(() => createPigeonTransport(API_KEY, BASE_URL).send(MESSAGE));

      assert.equal(error.code, 'network_error');
      assert.equal(error.status, 0);
      assert.equal(stub.calls.length, 2);
    } finally {
      stub.restore();
    }
  });

  it('reports a timeout without spending a second deadline on it', async () => {
    const stub = stubFetch(async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      throw timeout;
    });
    try {
      const error = await captureMailError(() => createPigeonTransport(API_KEY, BASE_URL).send(MESSAGE));

      assert.equal(error.code, 'timeout');
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
});

/** Restores one environment variable, including the case where it was unset. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('transport selection', () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    apiKey: process.env.PIGEON_API_KEY,
    baseUrl: process.env.PIGEON_BASE_URL,
    from: process.env.EMAIL_FROM,
  };

  beforeEach(() => {
    setTransportForTests(null);
    delete process.env.PIGEON_API_KEY;
    delete process.env.PIGEON_BASE_URL;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    setTransportForTests(null);
    setEnv('NODE_ENV', saved.nodeEnv);
    setEnv('PIGEON_API_KEY', saved.apiKey);
    setEnv('PIGEON_BASE_URL', saved.baseUrl);
    setEnv('EMAIL_FROM', saved.from);
  });

  it('refuses to guess in production and names both variables', () => {
    process.env.NODE_ENV = 'production';

    assert.throws(() => getDefaultTransport(), /PIGEON_API_KEY and PIGEON_BASE_URL/);
  });

  it('prints in development, and says so once', async () => {
    process.env.NODE_ENV = 'development';

    const output = await captureLog(async () => {
      await sendMail({ to: MESSAGE.to, subject: MESSAGE.subject, text: MESSAGE.text });
    });

    assert.ok(output.includes('[mail] verification and reset links will appear here in the console'));
    assert.ok(output.includes(LINK));
  });

  it('sends through the service whenever both variables are set', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PIGEON_API_KEY = API_KEY;
    process.env.PIGEON_BASE_URL = BASE_URL;
    const stub = stubFetch(async () => jsonResponse({ id: 'msg_env' }));
    try {
      const result = await sendMail({ to: MESSAGE.to, subject: MESSAGE.subject, text: MESSAGE.text });

      assert.equal(result.messageId, 'msg_env');
      const call = stub.calls[0];
      assert.ok(call !== undefined);
      assert.equal(sentBody(call).from, 'no-reply@kenning.altan.fyi');
    } finally {
      stub.restore();
    }
  });

  it('sends from EMAIL_FROM when the deployment sets one', async () => {
    const transport = createMemoryTransport();
    setTransportForTests(transport);
    process.env.EMAIL_FROM = 'post@kenning.altan.fyi';

    await sendMail({ to: MESSAGE.to, subject: MESSAGE.subject, text: MESSAGE.text });

    assert.equal(transport.messages[0]?.from, 'post@kenning.altan.fyi');
  });
});
