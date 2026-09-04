import { Outlet, useMatches } from 'react-router';
import { accountMiddleware, superadminMiddleware } from '#app/middleware/auth';
import AppWrapper from '#app/components/app-wrapper';
import { z } from 'zod';

/**
 * The operator screens under `/super/`, and the only place `is_superadmin` is
 * read by a screen.
 *
 * TWO MIDDLEWARES, IN THIS ORDER. `accountMiddleware` resolves the session and
 * puts the account in context; `superadminMiddleware` reads that account and
 * refuses anyone whose `is_superadmin` is false. The second cannot stand alone,
 * because with no account in context it would refuse every caller.
 *
 * IT IS `accountMiddleware`, NOT `authMiddleware`. This layout nested under
 * `routes/_auth.tsx` until M189 (ADR-0010), which also demanded a linked
 * `users` row. That table and that middleware are gone: superadmin is a flag on
 * the account itself, so the account session is the whole prerequisite.
 */
export const middleware = [accountMiddleware, superadminMiddleware];

/** Route `handle` values are untyped by React Router; decode before reading. */
const baseHandleSchema = z
  .object({ title: z.string().optional(), backTo: z.string().optional() })
  .catch({});


export default function SuperadminLayout() {
  const matches = useMatches();
  const handle = baseHandleSchema.parse(matches[matches.length - 1]?.handle);

  return (
    <AppWrapper title={handle.title} backTo={handle.backTo}>
      <Outlet />
    </AppWrapper>
  );
}
