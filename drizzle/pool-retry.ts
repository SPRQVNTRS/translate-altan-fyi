import { z } from 'zod';

/** Structured context attached to every retry log line. */
export type RetryLogContext = {
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
  error: string;
};

export type RetryLogger = {
  warn: (msg: string, ctx: RetryLogContext) => void;
};

export type ConnectWithRetryOptions = {
  logger: RetryLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/**
 * The only capability `connectWithRetry` needs from a `pg.Pool`. Narrowing the
 * dependency to this contract lets real pools and test doubles both satisfy it
 * without assertions.
 */
export type ClientSource<TClient> = {
  connect: () => Promise<TClient>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Postgres SQLSTATE codes that signify configuration errors, not transients.
// Retrying these just delays a guaranteed crash by ~61s with no upside.
const NON_RETRIABLE_PG_CODES = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name (database does not exist)
  '42501', // insufficient_privilege
]);

/** The SQLSTATE code pg attaches to driver errors. */
const pgDriverErrorSchema = z.object({ code: z.string() });

/** Decoded, domain-level view of one failed `connect()` attempt. */
export type PoolConnectFailure = {
  /** Human-readable detail, flattened across AggregateError members. */
  readonly description: string;
  /** True when the failure is a configuration error worth failing fast on. */
  readonly nonRetriable: boolean;
};

/**
 * Decode a thrown value into a `PoolConnectFailure` — the single I/O boundary
 * where an unparsed rejection becomes a domain value.
 *
 * pg's Pool surfaces ECONNREFUSED (and other low-level failures) as an
 * AggregateError whose top-level `.message` is empty — the diagnostic detail
 * lives in `.errors[]`. Unwrap so logs are actually useful.
 */
function decodePoolFailure(cause: unknown): PoolConnectFailure {
  if (cause instanceof AggregateError) {
    const members: PoolConnectFailure[] = cause.errors.map(decodePoolFailure);
    const joined = members
      .map((member) => member.description)
      .filter(Boolean)
      .join('; ');
    return {
      description: joined || cause.message || 'AggregateError',
      // Only fail-fast when every sub-error is non-retriable. A single retriable
      // sub-error (e.g. ECONNREFUSED) means the failure could still be transient.
      nonRetriable: members.length > 0 && members.every((member) => member.nonRetriable),
    };
  }

  if (!(cause instanceof Error)) {
    return { description: String(cause), nonRetriable: false };
  }

  const driverError = pgDriverErrorSchema.safeParse(cause);
  return {
    description: cause.message,
    nonRetriable: driverError.success && NON_RETRIABLE_PG_CODES.has(driverError.data.code),
  };
}

/**
 * Acquire a client from the pool, retrying on failure with bounded exponential
 * backoff capped at 30s per attempt and ±20% jitter.
 *
 * The base delay between attempts is `min(1000 * 2^attempt, 30_000)` ms
 * (attempt is 0-indexed). Worst-case total backoff is ~61s across 6 attempts.
 *
 * On exhaustion, rethrows the original error from the final attempt unchanged.
 *
 * @param maxAttempts - total attempts before giving up. Pass `1` for fail-fast
 *   behaviour (CLI commands, tests).
 */
export async function connectWithRetry<TClient>(
  pool: ClientSource<TClient>,
  maxAttempts: number,
  opts: ConnectWithRetryOptions,
): Promise<TClient> {
  const { logger, sleep = defaultSleep, random = Math.random } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await pool.connect();
    } catch (err) {
      lastError = err;
      const failure = decodePoolFailure(err);
      if (failure.nonRetriable) {
        logger.warn('Database pool connection failed with non-retriable error, aborting retry', {
          attempt,
          error: failure.description,
        });
        break;
      }
      if (attempt === maxAttempts - 1) break;
      const base = Math.min(1000 * 2 ** attempt, 30_000);
      const delayMs = Math.round(base * (0.8 + random() * 0.4));
      logger.warn('Database pool connection attempt failed, retrying', {
        attempt,
        maxAttempts,
        delayMs,
        error: failure.description,
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
