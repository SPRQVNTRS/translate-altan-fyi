/**
 * Express middleware that makes `/api/v1/*` behave like a JSON API even on
 * the failure paths.
 *
 * Without this, React Router's session-based auth would respond to an
 * unauthenticated request with a 302 redirect to `/login` and HTML, which
 * is the wrong shape for CLI / agent / third-party clients. We short-circuit
 * those requests with a JSON 401 before they ever reach the SSR handler.
 *
 * The middleware does NOT verify the API key — it only ensures a
 * well-formed `Authorization: Bearer <token>` header is present and lets
 * the request through. Actual key verification happens inside route
 * handlers (added in M1 spec 02+) so individual routes can scope keys.
 *
 * See `.adr/0001-cli-wraps-the-api.md`.
 */

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

const API_V1_PREFIX = '/api/v1/';

/**
 * The `/api/v1/*` paths this middleware must NOT touch, because they are
 * authenticated by the SESSION COOKIE rather than by a bearer API key.
 *
 * THIS LIST IS LOAD-BEARING, NOT AN OPTIMIZATION. Without it the guard below
 * answers `401` to every request under these prefixes before the route ever
 * runs — including `POST /api/v1/auth/login`, whose entire purpose is to be
 * callable without a credential. A signed-out browser could then never sign
 * in, and the failure would look like a broken login form rather than a
 * middleware match.
 *
 * The exempted routes are not unauthenticated. They resolve an opaque access
 * token out of the httpOnly session cookie
 * (`app/middleware/auth.ts`'s `resolveUser`) and answer their own `401` in the
 * same JSON envelope this middleware uses. What they do not carry is an
 * `Authorization` header, which is the only thing this guard knows how to
 * check.
 */
const SESSION_AUTH_PREFIXES = ['/api/v1/auth/', '/api/v1/sync/'] as const;

/**
 * The `/api/v1/*` paths that carry NO credential at all, by design.
 *
 * `/api/v1/transcribe` is the voice fallback's server half. Its caller is a
 * browser with no Web Speech API, not an API client, and the product has no
 * account requirement and no payment, so there is no credential for it to
 * send. It is guarded by the shared per-IP and per-session hourly limits and
 * by the daily budget cap instead.
 *
 * THIS ENTRY IS LOAD-BEARING. Without it the guard below answers 401 to every
 * recording before the route runs, and the fallback is dead for exactly the
 * browsers it exists to serve. A stage check caught that on 2026-09-02, and
 * `tests/unit/transcribe.test.ts` now pins it.
 */
const CREDENTIAL_FREE_PREFIXES = ['/api/v1/transcribe'] as const;

/** A well-formed `Authorization: Bearer <token>` header. */
const bearerHeaderSchema = z.string().regex(/^Bearer\s+\S+/i);

/**
 * Whether a path is one this guard demands a bearer token for.
 *
 * A PURE FUNCTION, SO IT CAN BE TESTED WITHOUT EXPRESS. The decision is the
 * whole of the guard's policy, and a test that had to fake a request and a
 * response object would be testing the fakes as much as the rule. Everything
 * below it is plumbing.
 *
 * @param path the request path, as Express reports it.
 */
export function requiresBearerToken(path: string): boolean {
  if (!path.startsWith(API_V1_PREFIX)) return false;
  if (SESSION_AUTH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (CREDENTIAL_FREE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return true;
}

export function apiJsonMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!requiresBearerToken(req.path)) {
    next();
    return;
  }
  if (!bearerHeaderSchema.safeParse(req.headers.authorization).success) {
    res.status(401).json({
      error: 'unauthorized: missing or invalid Authorization header — provide "Authorization: Bearer <api-key>"',
    });
    return;
  }
  next();
}
