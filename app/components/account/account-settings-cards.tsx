import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useRevalidator } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { signOutOfSync } from '#app/components/account/sync-client';
import { SyncUnlockCard } from '#app/components/account/sync-unlock-card';
import { getSyncSession } from '#app/lib/sync/sync-session';

/**
 * The account cards on the settings screen: the two doors when signed out, and
 * signing out when signed in.
 *
 * It is not the only door any more. The home page, `/account` and the shell
 * header carry the same pair, because an account is required for every search
 * since M184. What is still true is that this screen never presents sync as a
 * thing to set up: the user creates an ACCOUNT, and syncing to a second device
 * is what holding one gives them.
 *
 * ── Why there is no control for replacing the recovery code ──────────────
 *
 * Its absence is a decision, not an oversight. The service registers the
 * recovery verifier when the account is created or never, so a freshly minted
 * code could still unwrap the data but could no longer prove anything to the
 * recover endpoint: the user would be handed a credential that authenticates
 * nowhere. `openplate-sync` deleted its own version of this button in M181 for
 * exactly that reason, and this repo follows the source rather than diverging
 * on security-critical code (see `.adr/0008-e2ee-sync-copied-not-extracted.md`).
 * The real fix is an atomic, session-authorised rotation that moves the key
 * record and the verifier together, and it belongs in `openplate-sync` first
 * and is copied here afterwards. It is a tracked follow-up.
 */
export function AccountSettingsCards({ isSignedIn, handle }: { isSignedIn: boolean; handle: string | null }) {
  // THREE STATES, NOT TWO. Being signed in and holding the data key are
  // different facts: the session cookie survives a reload and the key does
  // not, so a device can be signed in and unable to sync. The loader answers
  // the first; only this browser can answer the second.
  //
  // Read once at mount rather than watched. The key can only appear while this
  // screen is open by way of the card below, which says so through
  // `onUnlocked`, and it renders `null` on the server for every visitor, which
  // is exactly what a freshly loaded page holds.
  const [hasDataKey, setHasDataKey] = useState(() => getSyncSession() !== null);

  if (!isSignedIn) return <CreateAccountCard />;
  if (!hasDataKey && handle !== null) {
    return (
      <>
        <SyncUnlockCard handle={handle} onUnlocked={() => setHasDataKey(true)} />
        <SignOutCard />
      </>
    );
  }
  return <SignOutCard />;
}

/** The card a user with no account sees: what an account is for, and the two ways in. */
function CreateAccountCard() {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.settingsCardTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('account.settingsCardBody')}</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button asChild>
          <Link to="/sign-up">{t('account.settingsCardAction')}</Link>
        </Button>
        {/* The second device's way in. It is a quiet secondary action, not a
            call to action: a visitor who has never made an account has nothing
            to sign in to. */}
        <Button asChild variant="ghost">
          <Link to="/sign-in">{t('account.signInAction')}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Signing out on this device. The local data stays; only the session goes. */
function SignOutCard() {
  const { t } = useTranslation();
  const revalidator = useRevalidator();
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async (): Promise<void> => {
    setError(null);
    setIsWorking(true);
    try {
      await signOutOfSync();
      // The card set is chosen by the loader's view of the session, so the
      // screen only changes once the loader has been asked again.
      await revalidator.revalidate();
    } catch {
      setError(t('sync.genericError'));
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.signOutTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('account.signOutBody')}</p>
      <Button type="button" variant="outline" className="mt-4" disabled={isWorking} onClick={handleSignOut}>
        {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('account.signOutAction')}
      </Button>
      {error !== null && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
