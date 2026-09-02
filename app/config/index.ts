/**
 * Centralized Application Configuration
 *
 * Single source of truth for all environment variable access.
 *
 * Benefits:
 * - Type-safe configuration access throughout the application
 * - Single place to see all environment variable requirements
 * - Runtime validation with clear error messages
 * - Easy to mock for testing
 * - Clear separation of concerns: environment config vs domain config vs constants
 *
 * Usage:
 * ```typescript
 * import { CONFIG } from '#app/config';
 *
 * const port = CONFIG.server.port;
 * const isProduction = CONFIG.app.isProduction;
 * ```
 */

import { requireEnv, optionalEnv, optionalBoolEnv, optionalIntEnv } from '@sprqvntrs/helpers';

/**
 * Parses the `TRUST_PROXY` env var into a value suitable for Express's
 * `app.set('trust proxy', <value>)`. Deliberately polymorphic (matches
 * Express's own accepted argument shapes), so this does NOT use the
 * single-type `optional*Env` helpers above.
 *
 * - unset/empty -> `1` hop in production (single Traefik hop), `false` otherwise
 *   (dev/test has no proxy in front of it and must not trust spoofable
 *   X-Forwarded-* headers)
 * - 'true' / 'false' (case-insensitive) -> boolean
 * - integer string (e.g. '1', '2') -> number of hops to trust
 * - anything else -> trimmed string as-is (Express presets/CIDRs, e.g.
 *   'loopback', '10.0.0.0/8', 'uniquelocal', or a comma-separated list)
 */
function parseTrustProxy(raw: string | undefined, isProduction: boolean): boolean | number | string {
  if (raw === undefined || raw.trim() === '') return isProduction ? 1 : false;
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const CONFIG = {
  /**
   * Application Environment
   */
  app: {
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
    isTest: process.env.NODE_ENV === 'test',
    url: optionalEnv('APP_URL', 'http://localhost:3000'),
  },

  /**
   * Server Configuration
   */
  server: {
    port: optionalIntEnv('PORT', 3000),
    hmrPort: optionalIntEnv('HMR_PORT', 24678),
    /**
     * Express `trust proxy` setting. Required behind a reverse proxy (Traefik)
     * so `request.url`'s host/proto reflect X-Forwarded-* headers — React
     * Router v8's CSRF check compares the browser's Origin against that host,
     * so without this, same-origin POST actions get aborted in production.
     * Configurable via TRUST_PROXY (see parseTrustProxy above for accepted formats).
     */
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'),
  },

  /**
   * Database Configuration
   */
  database: {
    host: optionalEnv('DB_HOST', 'localhost'),
    port: optionalIntEnv('DB_PORT', 5432),
    user: optionalEnv('DB_USER', 'postgres'),
    password: optionalEnv('DB_PASSWORD', 'postgres'),
    name: optionalEnv('DB_NAME', 'translate_altan_fyi'),
    ssl: optionalBoolEnv('DB_SSL', false),
    get url() {
      return `postgres://${this.user}:${this.password}@${this.host}:${this.port}/${this.name}`;
    },
    pool: {
      max: optionalIntEnv('DB_POOL_MAX', 10),
      min: optionalIntEnv('DB_POOL_MIN', 2),
      idleTimeoutMillis: optionalIntEnv('DB_IDLE_TIMEOUT_MS', 30000),
      connectionTimeoutMillis: optionalIntEnv('DB_CONNECTION_TIMEOUT_MS', 5000),
    },
  },

  /**
   * Session Configuration
   */
  session: {
    get secret() {
      return CONFIG.app.isProduction ? requireEnv('SESSION_SECRET') : 's3cr3t';
    },
  },

  /**
   * Superadmin Configuration
   */
  superadmin: {
    email: optionalEnv('SUPERADMIN_EMAIL', 'superadmin@example.com'),
    password: optionalEnv('SUPERADMIN_PASSWORD', 'password'),
  },

  /**
   * Logging Configuration
   */
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
  },

  /**
   * Feature Flags
   */
  features: {
    debugMode: optionalBoolEnv('DEBUG_MODE', false),
  },
} as const;

export type Config = typeof CONFIG;
