/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/engine/client/fetch-impl.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The default `fetch` for the sync clients — a lambda, never a bare reference.
 *
 * ── The bug this exists to prevent ───────────────────────────────────────
 *
 * `fetch` is a WebIDL operation on `Window`, so it brand-checks its receiver.
 * WebIDL replaces a `null`/`undefined` `this` with the global object, which is
 * why an ordinary `fetch(url)` works everywhere. Anything ELSE as the receiver
 * is rejected:
 *
 *     TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
 *
 * The sync clients store their fetch on the instance and call it as
 * `this.fetchImpl(url, init)` — a METHOD call, so the receiver is the client
 * object. With `fetchImpl = fetch` as the default, that is the forbidden case,
 * and in Chrome every single request threw before it left the page. The error
 * mapping turned it into "The sync server could not be reached", which sent
 * two rounds of debugging at the network instead of at the receiver.
 *
 * Node's `fetch` has no such brand check, so every unit and integration test
 * passed. It was also invisible under instrumentation: patching
 * `window.fetch` with a bound wrapper made the failure disappear completely,
 * which is what made it look intermittent when it was 100% deterministic.
 *
 * ── Why a lambda rather than `fetch.bind(globalThis)` ────────────────────
 *
 * `.bind()` captures the global's `fetch` ONCE, at module evaluation. A lambda
 * resolves it at call time, so a later replacement of `globalThis.fetch` — a
 * test hook, a mock-service worker, a browser extension — is still honoured.
 * Same correctness, strictly better behaviour under substitution, and it is
 * the form that stays right if this is ever copied elsewhere.
 */

/**
 * Calls the CURRENT global `fetch` with a receiver WebIDL accepts.
 *
 * Use this as the default for any injectable fetch that will be stored and
 * later invoked as a property (`this.fetchImpl(...)`, `deps.fetch(...)`).
 * A bare `= fetch` default is safe only if it is always called as a plain
 * local binding — a distinction too subtle to rely on at a distance.
 */
export const defaultFetchImpl: typeof fetch = (...args) => fetch(...args);
