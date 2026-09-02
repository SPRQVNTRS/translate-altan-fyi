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
 * (`app/services/account-session.server.ts`) and answer their own `401` in the
 * same JSON envelope this middleware uses. What they do not carry is an
 * `Authorization` header, which is the only thing this guard knows how to
 * check.
 */
const SESSION_AUTH_PREFIXES = ['/api/v1/auth/', '/api/v1/sync/'] as const;

/** A well-formed `Authorization: Bearer <token>` header. */
const bearerHeaderSchema = z.string().regex(/^Bearer\s+\S+/i);

export function apiJsonMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith(API_V1_PREFIX)) {
    next();
    return;
  }
  if (SESSION_AUTH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
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
