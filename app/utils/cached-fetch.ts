interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Default budget for one upstream request.
 *
 * 30 s, sized for a generic JSON API called from a request-serving process:
 * long enough for a slow-but-working upstream, short enough that a hung one
 * cannot hold a request open. This MUST stay well under Node's invisible 300 s
 * undici default — without an explicit bound, every caller of this wrapper
 * silently inherits a five-minute stall. Override per call with `timeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Combines the wrapper's own timeout with any signal the caller supplied, so a
 * caller-provided signal is honoured rather than silently replaced.
 */
function buildSignal(timeoutMs: number, callerSignal?: AbortSignal | null): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  return AbortSignal.any([timeoutSignal, callerSignal]);
}

export async function cachedFetch<T>(
  url: string,
  options?: { ttl?: number; timeoutMs?: number; init?: RequestInit },
): Promise<T> {
  const ttl = options?.ttl ?? DEFAULT_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // SAFETY: the caches are keyed by URL and every caller of a given URL must
  // agree on its response type — `cachedFetch<T>` is the only writer, and it
  // stores exactly what it later reads back. TypeScript cannot tie a Map key
  // to a per-key value type, so the entry is stored as `unknown`.
  const cached = cache.get(url) as CacheEntry<T> | undefined;
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }

  // SAFETY: same URL-to-type correspondence as the `cache` read above.
  const pending = inflight.get(url) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }

  const fetchPromise = fetch(url, {
    ...options?.init,
    signal: buildSignal(timeoutMs, options?.init?.signal),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `cachedFetch failed: ${response.status} ${response.statusText}`,
        );
      }
      // SAFETY: `T` is the response contract the caller declared for this
      // URL. `cachedFetch` is a transport, not a validator — a caller that
      // needs the payload checked must parse the value it gets back.
      const data = (await response.json()) as T;
      cache.set(url, { data, expiry: Date.now() + ttl });
      return data;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, fetchPromise);

  return fetchPromise;
}

export function invalidateCache(url?: string): void {
  if (url) {
    cache.delete(url);
  } else {
    cache.clear();
  }
}
