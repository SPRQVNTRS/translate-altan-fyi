import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useRevalidator } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { signOutOfSync } from '#app/components/sync/sync-client';
import { SyncUnlockCard } from '#app/components/sync/sync-unlock-card';
import { getSyncSession } from '#app/lib/sync/sync-session';

/**
 * The sync cards on the settings screen, and the ONLY place in this product
 * that offers an account.
 *
 * The app is anonymous and local first: search, lists and history all work
 * with no account at all. An account exists for exactly one reason, which is
 * that the user asked to study on a second device. So there is no nav item, no
 * header button and no banner anywhere else, and a first-time visitor is never
 * asked to sign up. Adding an entry point outside this file would be a
 * product bug, not a feature.
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
export function SyncSettingsCards({ isSignedIn, handle }: { isSignedIn: boolean; handle: string | null }) {
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

  if (!isSignedIn) return <SyncSetupCard />;
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

/** The card a user with no sync account sees: what sync is, and the two ways in. */
function SyncSetupCard() {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('sync.settingsCardTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('sync.settingsCardBody')}</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button asChild>
          <Link to="/sync/setup">{t('sync.settingsCardAction')}</Link>
        </Button>
        {/* The second device's way in. It is a quiet secondary action, not a
            call to action: a visitor who has never set sync up has nothing to
            sign in to. */}
        <Button asChild variant="ghost">
          <Link to="/sync/login">{t('sync.loginSubmitAction')}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Turning sync off on this device. The local data stays; only the session goes. */
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
      <h2 className="font-display text-base font-semibold">{t('sync.signOutTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('sync.signOutBody')}</p>
      <Button type="button" variant="outline" className="mt-4" disabled={isWorking} onClick={handleSignOut}>
        {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('sync.signOutAction')}
      </Button>
      {error !== null && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
