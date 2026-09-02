import type { JsonObject } from '#app/lib/json';

/**
 * Application-wide error reporting seam. This module is CLIENT-SAFE and must stay
 * that way: it is imported by the error boundaries (`app/root.tsx`,
 * `app/components/route-error-boundary.tsx`, `app/routes/org/_layout.tsx`), so it is
 * reachable from the browser bundle.
 *
 * It used to reach the structured logger through a dynamic
 * `import('#app/lib/report-error.server')` behind an `import.meta.env.SSR` guard. That
 * import was removed: React Router's Vite plugin rejects a `.server` specifier at
 * import-analysis time, BEFORE any dead-branch elimination, so in dev the whole module
 * 404'd, `app/root.tsx` could not load, and hydration never started anywhere in the app.
 * Production tree-shook the branch away, which is why only dev was broken and no gate
 * caught it. So: no reference of any kind to a `.server` module belongs in this file.
 *
 * Instead the server installs itself. A module graph that never reaches
 * `report-error.server` has no sink and logs to the console, which is exactly right in
 * the browser and acceptable for an SSR render-phase boundary, where a console line still
 * lands in the server's stdout.
 *
 * Safe to call from a render path (error boundaries) — never throws.
 */

/** Structured fields attached to an error report, forwarded to the logger. */
export type ErrorContext = JsonObject;

/** The sink signature, identical to `reportError` so an implementation can stand in for it. */
export type ErrorReporter = (cause: unknown, context?: ErrorContext) => void;

let reporter: ErrorReporter | null = null;

/**
 * Install (or with `null`, remove) the reporting sink. Called at module load by
 * `report-error.server`, and available to a test that wants to observe reports.
 */
export function setErrorReporter(report: ErrorReporter | null): void {
  reporter = report;
}

export function reportError(cause: unknown, context?: ErrorContext): void {
  const sink = reporter;
  if (!sink) {
    console.error('[reportError]', context ?? {}, cause);
    return;
  }
  try {
    sink(cause, context);
  } catch (sinkFailure) {
    // A reporting failure must never escalate into a second render-phase throw, and it
    // must not swallow the original cause either, so both go to the console.
    console.error('[reportError] reporter failed', sinkFailure);
    console.error('[reportError]', context ?? {}, cause);
  }
}
