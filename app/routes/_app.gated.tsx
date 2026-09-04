import { Outlet } from 'react-router';
import { accountMiddleware } from '#app/middleware/auth';

/**
 * The half of the app shell that requires an account (M184, ADR-0009).
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY THE MIDDLEWARE IS NOT ON `_app.tsx`.
 *   Middleware is exported per MODULE and applies to every route matched under
 *   it, so a `middleware` export on `_app.tsx` would gate everything inside the
 *   shell, `/` included. `/` is the landing page: a signed-out stranger must
 *   get a 200 there with a real worked example, which is the hard requirement
 *   this milestone is built around. A layout-level redirect on `_app` would
 *   break exactly that, so the gated routes get a pathless layout of their own
 *   and the public ones stay beside it. The nesting is the classification: a
 *   route file inside this block is gated because of where it sits, not
 *   because a list somewhere says so.
 *
 *   REJECTED: one middleware on `_app.tsx` that reads the request path and
 *   waives itself for the public ones. That is a path-keyed rule, and this
 *   milestone exists because a path-keyed rule gated `/search` while leaving
 *   `/?q=` wide open. A rule keyed on the shape of the request belongs in the
 *   loader that reads that shape, which is where `search.tsx` now carries it.
 *
 * WHAT IS NOT IN HERE, DELIBERATELY. `/`, `/search`, `/account`, `/sync/login`,
 * `/sync/setup` and `/offline` all stay outside: the first two are public with
 * a request-keyed rule inside their shared loader, the next three are the front
 * door an invited person arrives through, and `/offline` must render with no
 * network at all, which is not a state in which a session can be resolved.
 *
 * IT RENDERS NOTHING OF ITS OWN. `AppWrapper` is already around it, one level
 * up, so a second chrome here would be a frame inside a frame.
 *
 * IT TOUCHES NO LOCAL DATA. The gate blocks the SCREEN, never the device's own
 * store: a visitor's lists and history are theirs, they were never uploaded,
 * and a redirect must not be the thing that deletes them.
 */
export const middleware = [accountMiddleware];

export default function GatedAppLayout() {
  return <Outlet />;
}
