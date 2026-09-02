import { Outlet, useMatches } from 'react-router';
import { superadminMiddleware } from '#app/middleware/auth';
import AppWrapper from '#app/components/app-wrapper';
import { z } from 'zod';

/**
 * Layout for superadmin-only routes.
 * Requires the user to have isSuperadmin: true
 */
export const middleware = [superadminMiddleware];

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
