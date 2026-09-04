import { redirect } from 'react-router';
import type { MetaFunction } from 'react-router';
import type { Route } from './+types/sign-up';
import { CreateAccountFlow } from '#app/components/account/create-account-flow';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';
import { getAccountSession } from '#app/services/account-session.server';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'account.createMetaTitle') },
    { name: 'description', content: metaTitle(language, 'account.createMetaDescription') },
  ];
};

/**
 * The name of this screen, for the chrome's `h1`.
 *
 * The header reads the nav catalog by default, and account creation is
 * deliberately not in the nav: it is reached from the home page, from
 * `/account` and from `/sign-in`. Without a handle the `h1` falls back to the
 * app name, so the mobile header renders "translate" twice, once as the logo
 * and once as the title. The key is the one the `<title>` already uses, so the
 * tab and the header can never disagree.
 */
export const handle = { titleKey: 'account.createMetaTitle' } satisfies TitleHandle;

/**
 * A reader who already has an account, sent to it; otherwise the invite token
 * from the URL, and nothing else.
 *
 * THE REDIRECT IS NOT A GATE, IT IS THE ANSWER TO A FINISHED QUESTION. This
 * screen creates an account, and somebody signed in has one: rendering the form
 * to them offers a second account they cannot want and, worse, a fresh sign-in
 * name and recovery code that would replace the session they are holding. It
 * costs one indexed lookup, `getAccountSession`, which resolves the access
 * token and NEVER throws. A cookie whose token is expired or revoked therefore
 * gets the form, which is the only safe way round: a check that trusted the
 * cookie alone would lock a stale session out of the two screens that could
 * end it.
 *
 * `/sign-up` STAYS CLASSIFIED PUBLIC in `app/lib/route-classification.ts`, and
 * that is not an oversight. Nobody is refused here. A signed-out stranger, the
 * one caller this screen exists for, reaches it exactly as before.
 *
 * An invite arrives out of band as a link, so `/sign-up?invite=<token>` is the
 * shape a reader is handed. Reading it here rather than in client code keeps
 * one answer to "which token is this visit carrying", and the value is a
 * one-time admission ticket the server checks again at signup: it is not a
 * credential and nothing is decided from it on this screen.
 *
 * An absent or empty parameter is `null`, so the form has one case to handle
 * rather than two.
 *
 * @param request the incoming request, read for its session cookie and its
 *   query string.
 * @returns a redirect to `/account` for a signed-in reader, otherwise the
 *   invite token, or `null` when the visit carries none.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<Response | { invite: string | null }> {
  const account = await getAccountSession(request);
  if (account !== null) throw redirect('/account');

  const invite = new URL(request.url).searchParams.get('invite');
  return { invite: invite === null || invite === '' ? null : invite };
}

/**
 * Creating an account, at `/sign-up`.
 *
 * THE PATH AND THE WORDS BOTH SAY "ACCOUNT". This screen used to be
 * `/sync/setup`, titled "Set up sync", which asked a newcomer to configure a
 * feature before they had the thing that feature applies to. `/sync/setup`
 * still answers, with a permanent redirect from `sync.setup-redirect.ts`.
 *
 * No action, on purpose. Every value this screen handles is a secret that must
 * not leave the browser, so the work happens in client code and reaches the
 * service through `fetch`. A route action would run on the server, which is
 * precisely where none of this may go. The loader above is the one exception,
 * and it reads nothing secret either: an invite token the reader was sent in
 * the open, plus the session cookie, which it uses to send a reader who already
 * holds an account to `/account` rather than to a form that would mint them a
 * second one. It reads no password, no recovery code and no key, and it writes
 * nothing.
 */
export default function SignUpRoute({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* The loader's answer, handed down. The flow falls back to reading
          `?invite=` itself when this is null, so a link opened without the
          loader's answer still fills the field. */}
      <CreateAccountFlow invite={loaderData.invite} />
    </div>
  );
}
