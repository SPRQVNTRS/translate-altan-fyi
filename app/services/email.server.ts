/**
 * email.server.ts, the mail seam: one transport interface, three implementations.
 *
 * The service this app sends through (pigeon) ships an SDK, and this file
 * deliberately does not use it. The SDK is a PRIVATE package on GitHub
 * Packages; this repository is public MIT and its production build mounts no
 * registry credential, so a dependency on it would make the app unbuildable
 * for anyone outside the workspace, including the build server. The wire
 * contract is four fields and one header, so it is written out here against
 * global `fetch` and nothing else.
 *
 * The transport is resolved LAZILY, on the first send, never at module load.
 * A module-scope `getDefaultTransport()` turns a missing production variable
 * into a boot crash of the whole web server, which is a much worse failure
 * than a failed password reset: the site goes dark because one mail could not
 * have been sent. So the guard fires on the first send attempt instead.
 *
 * `sendMail` takes a finished subject and body. It does not know the reader's
 * language and must not: the caller has the request, and therefore the only
 * honest source of the language, and passes a `t` to the templates in
 * `app/emails/`. See `app/emails/i18n.server.ts`.
 */
import { z } from 'zod';

/** The default sender. Overridden with `EMAIL_FROM`, which production sets. */
const DEFAULT_FROM = 'no-reply@translate.altan.fyi';

/** How long one send attempt may take before it is abandoned. */
const SEND_TIMEOUT_MS = 15_000;

/** A message as the transports see it: plain text, one recipient, no HTML part. */
export type EmailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Makes a retried send idempotent at the mail service, when the caller has a stable key. */
  idempotencyKey?: string;
};

/** What a successful send hands back: the mail service's own id, for the logs. */
export type EmailSendResult = {
  messageId: string;
};

/** The one thing every transport does. */
export type EmailTransport = {
  send(message: EmailMessage): Promise<EmailSendResult>;
};

/**
 * Why a send failed, in the four shapes a caller can act on.
 *
 * `rate_limited` is worth a retry later, `timeout` and `network_error` are
 * worth an immediate retry, and an `http_<status>` is a bug or a bad address
 * and is worth neither. The template literal keeps the status readable in a
 * log line without a second field to look up.
 */
export type MailErrorCode = 'rate_limited' | 'timeout' | 'network_error' | `http_${number}`;

/**
 * A failed send.
 *
 * Carries the classification and the HTTP status, so a caller can branch
 * without parsing the message. `status` is `0` when the request never got an
 * answer at all, which is the honest value for a timeout or a dead socket.
 */
export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly status: number;

  constructor(message: string, code: MailErrorCode, status: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'MailError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The success body of `POST /v1/emails`.
 *
 * Parsed rather than asserted: the answer comes off the network, so an
 * unexpected shape has to become a `MailError` and not an `undefined` message
 * id travelling into a log line.
 */
const PigeonSendResponseSchema = z.object({ id: z.string() });

/** A thrown value that is a request timeout rather than a dead network. */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}

/** The message of a thrown value, without asserting it is an `Error`. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The real transport: one POST per message.
 *
 * Two parameters of the same type, in the order the reference implementation
 * in `selfhostedworld-com` uses, kept identical on purpose so the two files
 * read as the same thing.
 *
 * @param apiKey - the tenant key, sent as a bearer token.
 * @param baseUrl - the service root, e.g. `http://100.64.0.1:3601`.
 */
export function createPigeonTransport(apiKey: string, baseUrl: string): EmailTransport {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/emails`;

  async function attempt(message: EmailMessage): Promise<EmailSendResult> {
    const headers = new Headers({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });
    if (message.idempotencyKey !== undefined) headers.set('Idempotency-Key', message.idempotencyKey);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const code: MailErrorCode = response.status === 429 ? 'rate_limited' : `http_${response.status}`;
      throw new MailError(`mail service returned ${response.status}: ${detail.slice(0, 200)}`, code, response.status);
    }

    const parsed = PigeonSendResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new MailError(
        'mail service returned a body without a message id',
        `http_${response.status}`,
        response.status,
      );
    }
    return { messageId: parsed.data.id };
  }

  return {
    async send(message) {
      try {
        return await attempt(message);
      } catch (cause) {
        // A `MailError` here is an answer from the service, so the message was
        // seen and must not be sent twice. Only a request that never arrived
        // is retried, and a timeout is not: the deadline already spent fifteen
        // seconds of the reader's wait, and doubling that helps nobody.
        if (cause instanceof MailError) throw cause;
        if (isTimeout(cause)) {
          throw new MailError(`mail service did not answer within ${SEND_TIMEOUT_MS} ms`, 'timeout', 0, cause);
        }
        try {
          return await attempt(message);
        } catch (retryCause) {
          if (retryCause instanceof MailError) throw retryCause;
          if (isTimeout(retryCause)) {
            throw new MailError(`mail service did not answer within ${SEND_TIMEOUT_MS} ms`, 'timeout', 0, retryCause);
          }
          throw new MailError(`mail service unreachable: ${describe(retryCause)}`, 'network_error', 0, retryCause);
        }
      }
    },
  };
}

/** The first line of the console transport's frame, so a reader can find it in a busy log. */
const CONSOLE_HEADER = '[mail] no PIGEON_API_KEY set, printing instead of sending';

/** The last line of the frame. */
const CONSOLE_FOOTER = '[mail] end of message';

/**
 * The development transport: it prints the whole mail, link included.
 *
 * The link is the point. Without a mail service a developer signing up locally
 * has no other way to reach the verification or reset URL, so the body is
 * printed in full and framed, rather than summarised.
 */
export function createConsoleTransport(): EmailTransport {
  return {
    async send(message) {
      console.log(CONSOLE_HEADER);
      console.log(`  to:      ${message.to}`);
      console.log(`  subject: ${message.subject}`);
      console.log('');
      console.log(message.text);
      console.log(CONSOLE_FOOTER);
      return { messageId: `console-${Date.now()}` };
    },
  };
}

/** A captured message, with the moment it was handed over. */
export type CapturedEmail = EmailMessage & { sentAt: Date };

/** The test transport, plus the two things a test does with it. */
export type MemoryTransport = EmailTransport & {
  messages: CapturedEmail[];
  clear(): void;
};

/** Records messages instead of sending them. For tests, and for nothing else. */
export function createMemoryTransport(): MemoryTransport {
  const messages: CapturedEmail[] = [];
  return {
    messages,
    clear() {
      messages.length = 0;
    },
    async send(message) {
      messages.push({ ...message, sentAt: new Date() });
      return { messageId: `memory-${messages.length}` };
    },
  };
}

/** Printed once, so a developer knows where the links will show up. */
const CONSOLE_NOTICE = '[mail] verification and reset links will appear here in the console';

/** Set by `setTransportForTests`. Wins over everything, including production. */
let overrideTransport: EmailTransport | null = null;

/** The resolved default, kept so the notice is printed once and not per mail. */
let defaultTransport: EmailTransport | null = null;

/**
 * The transport this deployment sends through.
 *
 * Production demands both variables and refuses to guess, because the console
 * fallback in production is a silent hole: signups would look fine and nobody
 * would ever get a mail. Any other environment sends through the service when
 * both variables are set, and otherwise prints.
 */
export function getDefaultTransport(): EmailTransport {
  if (defaultTransport !== null) return defaultTransport;

  const apiKey = process.env.PIGEON_API_KEY;
  const baseUrl = process.env.PIGEON_BASE_URL;

  if (process.env.NODE_ENV === 'production' && (apiKey === undefined || baseUrl === undefined)) {
    throw new Error(
      'PIGEON_API_KEY and PIGEON_BASE_URL are both required in production. ' +
        'Set them in the environment before starting the server.',
    );
  }

  if (apiKey !== undefined && baseUrl !== undefined) {
    defaultTransport = createPigeonTransport(apiKey, baseUrl);
    return defaultTransport;
  }

  console.log(CONSOLE_NOTICE);
  defaultTransport = createConsoleTransport();
  return defaultTransport;
}

/**
 * Replaces the transport for a test, or restores the real one with `null`.
 *
 * A registration slot rather than a module mock: the anti-slop lint bans
 * module mocking, and a slot is also what lets an integration test read the
 * mail a route just sent.
 */
export function setTransportForTests(transport: EmailTransport | null): void {
  overrideTransport = transport;
  defaultTransport = null;
}

/**
 * Sends one plain-text mail.
 *
 * @param message - recipient, subject, body, and an optional idempotency key.
 * @returns the mail service's message id.
 * @throws MailError when the service refuses or cannot be reached.
 */
export async function sendMail({
  to,
  subject,
  text,
  idempotencyKey,
}: {
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
}): Promise<EmailSendResult> {
  const transport = overrideTransport ?? getDefaultTransport();
  return transport.send({
    from: process.env.EMAIL_FROM ?? DEFAULT_FROM,
    to,
    subject,
    text,
    idempotencyKey,
  });
}
