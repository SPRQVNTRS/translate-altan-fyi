/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/local-store/offline-fallback.ts @ 68e893a.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 *
 * Shared predicate for `clientLoader`s that fall back to the local layer when
 * the network path fails. A route's `serverLoader()` call is a same-origin
 * single-fetch `.data` request; offline, the browser's `fetch` rejects with a
 * `TypeError` before any HTTP status exists. Used by every route with an
 * offline read fallback so the classification stays identical.
 */

/** True when a failed `serverLoader()` call should fall back to the local layer rather than surface as an error. */
export function shouldFallbackOffline(cause: unknown): boolean {
  if (globalThis.navigator !== undefined && !navigator.onLine) return true;
  // A network-level fetch failure throws a TypeError; a real app error (a thrown
  // Response, a redirect) should propagate to the router untouched.
  return cause instanceof TypeError;
}
