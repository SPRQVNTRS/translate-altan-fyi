import { logger } from '#app/lib/logger';
import type { ErrorContext } from '#app/lib/report-error';

export function reportErrorOnServer(cause: unknown, context?: ErrorContext): void {
  const normalized = cause instanceof Error ? cause : new Error(String(cause));
  logger.error('unhandled error', { ...context, error: normalized });
}
