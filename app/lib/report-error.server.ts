import { logger } from '#app/lib/logger';
import type { ErrorContext } from '#app/lib/report-error';
import { setErrorReporter } from '#app/lib/report-error';

export function reportErrorOnServer(cause: unknown, context?: ErrorContext): void {
  const normalized = cause instanceof Error ? cause : new Error(String(cause));
  logger.error('unhandled error', { ...context, error: normalized });
}

/**
 * The one name server entrypoints import, so `server.ts` and `worker.ts` do not have to
 * know that the server flavour is spelled differently.
 */
export const reportError = reportErrorOnServer;

// Deliberate import side effect: any module graph that reaches this file upgrades the
// client-safe seam from `console.error` to structured logging. The seam cannot import
// this module itself (React Router's Vite plugin rejects a `.server` specifier at
// import-analysis and that killed hydration repo-wide in dev), so the dependency is
// inverted and the server installs itself here.
setErrorReporter(reportErrorOnServer);
