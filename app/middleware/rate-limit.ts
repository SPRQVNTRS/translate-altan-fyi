/**
 * The per-route request limiter: a fixed number of attempts per address per
 * window.
 *
 * IT IS IN MEMORY, AND IT RESETS ON EVERY DEPLOY. That is accepted: this app
 * runs as ONE container, so a process-local map is the whole population, and a
 * limiter that survived restarts would need a table and a sweeper for a
 * defence whose job is to slow a script down rather than to be exact. If a
 * second instance ever appears, this module is the thing that has to move to
 * the database, and nothing else does.
 *
 * IT KEYS ON THE ADDRESS EXPRESS DERIVED, NEVER ON A FORWARDING HEADER. Behind
 * Traefik the forwarding header is a list the client can prepend to, so
 * counting it hands an attacker a fresh bucket per attempt. `server.ts` deletes
 * any incoming `x-client-ip`, resolves `req.ip` under the configured
 * `trust proxy` hop count, and writes the result into that header; this module
 * reads it and nothing else. A request that arrives without one is counted
 * under a single shared key rather than waved through, so a misconfiguration
 * fails closed.
 */
import type { MiddlewareFunction } from 'react-router';

/**
 * The header `server.ts` writes the proxy-resolved client address into.
 *
 * LOWER CASE, because Node normalizes incoming header names to lower case and
 * `delete req.headers[...]` has to match that form to remove a forged one.
 */
export const CLIENT_IP_HEADER = 'x-client-ip';

/** What a request with no resolvable address is counted under. One shared bucket, so the limiter fails closed. */
const UNKNOWN_CLIENT_KEY = 'unknown';

/** One bucket: the timestamps of the attempts still inside the window. */
const buckets = new Map<string, number[]>();

export interface RateLimitOptions {
  /** How many requests are allowed inside the window. */
  limit: number;
  /** The window, in milliseconds. */
  windowMs: number;
  /** Names the bucket, so `/sign-in` and `/sign-up` do not share a count. */
  name: string;
}

/**
 * A middleware that refuses once an address has spent its allowance.
 *
 * @param options the allowance, the window and the bucket name.
 * @returns a middleware that throws a `429` carrying `Retry-After`.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareFunction {
  return ({ request }) => {
    // Only the verbs that change something are counted. A limiter on a GET
    // would throttle a reader reloading the form they just failed to submit.
    if (request.method === 'GET' || request.method === 'HEAD') return;

    const key = `${options.name}:${clientAddress(request)}`;
    const now = Date.now();
    const recent = (buckets.get(key) ?? []).filter((at) => now - at < options.windowMs);

    if (recent.length >= options.limit) {
      buckets.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfter = Math.ceil((options.windowMs - (now - oldest)) / 1000);
      throw new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': String(Math.max(retryAfter, 1)) },
      });
    }

    recent.push(now);
    buckets.set(key, recent);
  };
}

/** Drops every bucket. For tests, which must not inherit another case's counts. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** The address this request is counted under. See the module header for why it is this header and no other. */
function clientAddress(request: Request): string {
  const address = request.headers.get(CLIENT_IP_HEADER);
  return address === null || address === '' ? UNKNOWN_CLIENT_KEY : address;
}
