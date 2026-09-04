import { redirect } from 'react-router';

/**
 * `/super` lands on `/super/llm`.
 *
 * Two operator screens are left under this prefix and only one of them is a
 * reason to come here: `llm` edits the model configuration enrichment reads,
 * `whoami-ip` answers a question you already know you are asking. So the bare
 * prefix is a hop to the first rather than an index listing two links.
 *
 * A TEMPORARY REDIRECT, unlike the `/sync/*` hops. Those record a rename that
 * is final; this one records today's shape of a small admin surface, and a
 * `301` sitting in an operator's browser cache would outlive the next screen
 * added here.
 *
 * No component and no default export: this file is a hop, not a screen. The
 * superadmin check runs before it, on `routes/_super.tsx`.
 */
export function loader(): Response {
  return redirect('/super/llm');
}
