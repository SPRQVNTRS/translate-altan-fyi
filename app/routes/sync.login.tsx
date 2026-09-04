import { Link } from 'react-router';
import type { MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '#app/components/ui/button';
import { SyncLoginForm } from '#app/components/sync/sync-login-form';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import type { TitleHandle } from '#app/lib/route-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [{ title: metaTitle(language, 'sync.loginMetaTitle') }];
};

/** The name of this screen, for the chrome's `h1`. See `sync.setup.tsx` for why sync routes need one. */
export const handle = { titleKey: 'sync.loginMetaTitle' } satisfies TitleHandle;

/**
 * Signing a second device in.
 *
 * No loader and no action, for the same reason as `/sync/setup`: the
 * passphrase is stretched in the browser and only the derived hash is sent.
 *
 * IT IS ALSO THE FRONT DOOR NOW, AND THAT IS WHY THE SECOND CARD IS HERE.
 *   Since M184 every gated screen redirects here, `/settings` included, and
 *   `/settings` used to hold the ONLY link in the app to `/sync/setup`. Without
 *   this card an invited person following the gate lands on a sign-in form for
 *   an account they have not created yet, with nothing on the page that leads
 *   anywhere, and the invite they were sent is unusable unless somebody told
 *   them the URL by hand. A milestone that hands out invites and then hides the
 *   door has shipped a wall.
 *
 *   IT IS A LINK, NOT A PROMPT. `/` and `/account` still ask nobody to sign up,
 *   which is the rule this product is built on. This page is different in kind:
 *   the reader is already here to deal with an account.
 */
export default function SyncLoginRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <SyncLoginForm />

      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('sync.loginNoAccountTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('sync.loginNoAccountBody')}</p>
        <Link to="/sync/setup" className={`${buttonVariants({ variant: 'outline' })} mt-4`}>
          {t('sync.loginNoAccountAction')}
        </Link>
      </div>
    </div>
  );
}
