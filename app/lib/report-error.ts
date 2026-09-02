import type { JsonObject } from '#app/lib/json';

/** Structured fields attached to an error report, forwarded to the logger. */
export type ErrorContext = JsonObject;

/**
 * Application-wide error reporting seam.
 *
 * Default behavior:
 * - Server: forwards to the structured logger (`@sprqvntrs/logger`).
 * - Client: writes to `console.error`.
 *
 * Consumers integrating Sentry / Datadog / Highlight should swap the body
 * of this function rather than patching every error boundary individually.
 *
 * The server module is loaded via `import.meta.env.SSR`-gated dynamic import
 * so Vite tree-shakes it out of the client bundle (pino does not ship to the
 * browser). Fire-and-forget — pino's stream flushes on its own schedule.
 *
 * Safe to call from a render path (error boundaries) — does not throw.
 */
export function reportError(cause: unknown, context?: ErrorContext): void {
  if (import.meta.env.SSR) {
    void import('#app/lib/report-error.server').then(({ reportErrorOnServer }) =>
      reportErrorOnServer(cause, context),
    );
    return;
  }
  console.error('[reportError]', context ?? {}, cause);
}
