import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import type { Route } from './+types/account';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { getAccountSession } from '#app/services/account-session.server';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'account.metaTitle') },
    { name: 'description', content: metaTitle(language, 'account.metaDescription') },
  ];
};

/**
 * IT DOES NOT REQUIRE AN ACCOUNT AND IT DOES NOT REDIRECT. Anonymous is the
 * NORMAL state here, not an error: search, lists and history all work with no
 * account, and this screen exists to report that state rather than to end it.
 * `getAccountSession` returns `null` for a signed-out visitor and never
 * throws, which is exactly the contract this loader needs.
 *
 * ONLY THE HANDLE CROSSES THE BOUNDARY. Not the account id, and above all not
 * the tokens the session cookie carries. A loader's return value is
 * serialized into the HTML and readable by any script on the page, which is
 * the precise property the httpOnly cookie exists to deny.
 *
 * @returns the signed-in handle, or `null`.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<{ handle: string | null }> {
  const session = await getAccountSession(request);
  return { handle: session?.handle ?? null };
}

/**
 * There are no plans and no payment in this product, so this screen is about
 * the device and the account, never about billing.
 *
 * NO SIGN-IN CALL TO ACTION, IN EITHER STATE. This is a navigation
 * destination, and an account prompt on one would make the app ask for an
 * account on a path that must never need one. The single entry point to
 * syncing is the card on `/settings`, and the signed-out copy says so.
 */
export default function AccountRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { handle } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {handle === null ? t('account.signedOutBody') : t('account.signedInBody')}
        </p>
        {handle !== null && (
          <div className="mt-4">
            <div className="text-xs text-muted-foreground">{t('account.handleLabel')}</div>
            <div className="mt-1 font-mono text-sm">{handle}</div>
          </div>
        )}
      </div>
    </div>
  );
}
