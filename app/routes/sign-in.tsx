import { redirect } from 'react-router';
import type { MetaFunction } from 'react-router';
import type { Route } from './+types/sign-in';
import { SignInForm } from '#app/components/account/sign-in-form';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { getAccountSession } from '#app/services/account-session.server';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [{ title: metaTitle(language, 'account.signInMetaTitle') }];
};

/** The name of this screen, for the chrome's `h1`. See `sign-up.tsx` for why these two routes need one. */
export const handle = { titleKey: 'account.signInMetaTitle' } satisfies TitleHandle;

/**
 * A reader who is already signed in, sent to `/account`.
 *
 * IT ASKS ONE QUESTION AND REFUSES NOBODY. A sign-in form shown to somebody
 * holding a session is a form with nothing to do: they arrive here from a
 * stale link or a back button, and the useful answer is the account they are
 * already in. `getAccountSession` resolves the access token and never throws,
 * so an expired or revoked session still gets the form and can sign in again.
 * A cookie-only check would have locked exactly that reader out.
 *
 * The route stays classified public in `app/lib/route-classification.ts`: this
 * is where every gated redirect lands, and nothing here can turn a signed-out
 * caller away.
 *
 * @param request the incoming request, read only for its session cookie.
 * @returns nothing for a signed-out caller.
 * @throws a `redirect` Response to `/account` when a session resolves.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<null> {
  const account = await getAccountSession(request);
  if (account !== null) throw redirect('/account');
  return null;
}

/**
 * Signing in, at `/sign-in`.
 *
 * THE PATH SAYS WHAT THE READER IS DOING, not what the machinery is called.
 * This screen used to be `/sync/login`, which named a consequence of holding an
 * account rather than the account itself. Sync is not something a person sets
 * up here: they sign in, and their devices then carry the same words.
 * `/sync/login` still answers, with a permanent redirect from
 * `sync.login-redirect.ts`.
 *
 * No action, for the same reason as `/sign-up`: the password is stretched in
 * the browser and only the derived hash is sent, so there is nothing for a
 * server handler to receive. The loader above touches none of that: it reads
 * the session cookie only, to send a reader who is already signed in to their
 * account instead of to a form they have no use for.
 *
 * THE WAY ON TO ACCOUNT CREATION IS THE FORM'S OWN LINE. `SignInForm` already
 * renders "No account yet? Create account" under its submit button, so this
 * route does not repeat it in a second card. Every gated screen redirects
 * here, and the home page and `/account` carry the same pair of doors since
 * M189, so a reader who has no account yet still finds the way to one.
 */
export default function SignInRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <SignInForm />
    </div>
  );
}
