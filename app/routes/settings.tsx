import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import type { Route } from './+types/settings';
import { LanguageToggle } from '#app/components/language-toggle';
import { SyncSettingsCards } from '#app/components/sync/sync-settings-cards';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { getAccountSession } from '#app/services/account-session.server';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'settings.metaTitle') },
    { name: 'description', content: metaTitle(language, 'settings.metaDescription') },
  ];
};

/**
 * Whether this browser holds a sync session, and the handle it holds it under.
 *
 * ── THE HANDLE IS RETURNED NOW, AND THIS IS WHY ──────────────────────────
 *
 * It used to be withheld, on the reasoning that the screen had no copy that
 * named it and a value nothing renders cannot leak into a screenshot. That
 * reasoning has changed on its premise rather than been dropped: the unlock
 * card needs the handle to re-derive the data key after a reload, because the
 * key lives in memory only and the handle is gone with it. Without it the card
 * would have to ask the user to retype an opaque machine-minted name they
 * never chose, on a screen that already knows it.
 *
 * It is acceptable because of what the value is and where it goes: the
 * account's own identifier, handed to its owner, on a page that only this
 * session's cookie can load. It is not a credential, and it opens nothing on
 * its own. Every secret the protocol has stays on the other side of this line,
 * and the passphrase, the KEK and the data key still never reach a loader.
 *
 * IT IS STILL NOT RENDERED. The card reads it and posts it; no element on this
 * screen prints it, so the screenshot argument above survives intact.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const account = await getAccountSession(request);
  return { isSignedIn: account !== null, handle: account?.handle ?? null };
}

export default function SettingsRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('settings.appearanceTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.appearanceBody')}</p>
      </div>
      {/* The app language is a real, working control, so it gets its own card
          rather than a line inside the one above, which describes things that
          are not built yet. */}
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('settings.languageTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.languageBody')}</p>
        <div className="mt-4">
          <LanguageToggle />
        </div>
      </div>
      <SyncSettingsCards isSignedIn={loaderData.isSignedIn} handle={loaderData.handle} />
    </div>
  );
}
