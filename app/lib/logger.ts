import { createLogger, type Logger } from '@sprqvntrs/logger';
import { z } from 'zod';

/** `LOG_LEVEL` from the environment; anything unrecognized falls back to `info`. */
const logLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  .catch('info');

/**
 * Application-wide logger instance.
 *
 * Uses @sprqvntrs/logger for structured logging with:
 * - Automatic redaction of sensitive fields
 * - Pretty printing in development
 * - JSON output in production
 */
export const logger = createLogger({
  serviceName: 'translate-altan-fyi',
  level: logLevelSchema.parse(process.env.LOG_LEVEL),
  pretty: process.env.NODE_ENV !== 'production',
});

/**
 * Create a child logger for a specific component/module.
 *
 * @example
 * const log = createComponentLogger('AuthService');
 * log.info('User logged in', { userId: '123' });
 */
export function createComponentLogger(component: string): Logger {
  return logger.child({ component });
}

export type { Logger };
