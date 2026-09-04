/**
 * The account paths, in a module with no server imports.
 *
 * WHY THEY ARE NOT IN `session.server.ts`. A route's COMPONENT renders in the
 * browser, and React Router only strips `loader`, `action`, `middleware` and
 * `headers` from a route module. A component that reads a constant out of a
 * `.server` file therefore drags the session store, the config and the database
 * pool into the client bundle, and the production build refuses it. Nothing in
 * a typecheck, a lint or a unit test sees that: `react-router build` is the
 * only gate that does.
 */

/** Where a signed-out visitor is sent when a route requires an account. */
export const SIGN_IN_PATH = '/sign-in';

/** Where a reader creates one. */
export const SIGN_UP_PATH = '/sign-up';
