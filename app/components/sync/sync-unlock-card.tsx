import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { unlockSyncSession } from '#app/components/sync/sync-client';
import { setSyncSession } from '#app/lib/sync/sync-session';
import { classifySignInFailure } from '#app/lib/e2ee/flows/sign-in-error';
import { reportError } from '#app/lib/report-error';

/**
 * The card a signed-in device shows when it holds no data key.
 *
 * ── The state this card exists for ───────────────────────────────────────
 *
 * The data key lives in a module variable for the lifetime of the page and is
 * written nowhere, so A RELOAD LOSES IT. That is the design and not a gap: a
 * key at rest on the device is a key an attacker with the device does not need
 * the passphrase for. But the session cookie is httpOnly and long lived, so
 * after a reload the browser is SIGNED IN AND CANNOT SYNC, and until this card
 * existed the screen said nothing at all. A user set sync up, closed the tab,
 * and every later edit stayed on the device while the settings screen showed a
 * sign-out button as if all were well.
 *
 * ── It is not an error, and must not read like one ───────────────────────
 *
 * Nothing is broken and nothing is lost: the lists are on the device and work
 * normally, and the only missing thing is the key. So this is an ordinary card
 * in the settings list, with no red, no alert styling and no warning icon. The
 * error line below appears only when an unlock is actually refused.
 *
 * ── The wait is the security property ────────────────────────────────────
 *
 * Argon2id at 64 MiB takes seconds, deliberately, so the button disables and
 * says so for the whole call rather than explaining it away afterwards.
 *
 * A wrong passphrase says only that. The service answers a single `401` for an
 * unknown handle and for a wrong passphrase alike so that no screen can be
 * used to ask whether an account exists, and this one must not undo that.
 */
export function SyncUnlockCard({ handle, onUnlocked }: { handle: string; onUnlocked: () => void }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isWorking) return;

    setError(null);
    setIsWorking(true);
    try {
      const session = await unlockSyncSession({ handle, passphrase });
      // Putting the key in the vault IS what starts the catch-up cycle: the
      // scheduler subscribes to the vault (`sync-session.ts`), so this device
      // pulls the account's blob straight away instead of waiting for the user
      // to switch tabs and come back. Nothing here calls a cycle itself, so
      // there is one trigger and not two.
      setSyncSession(session);
      // The passphrase is dropped from the field the moment it has been used.
      // It never left this call frame and the vault, and holding it in
      // component state past the call would be a fourth place it lives.
      setPassphrase('');
      toast.success(t('sync.unlockedToast'));
      onUnlocked();
    } catch (cause) {
      const failure = classifySignInFailure(cause);
      // A `rejected` is an ordinary typing mistake, not something to log.
      // Anything else is unexpected, and the payload is a fixed literal: the
      // passphrase and every key derived from it are in scope right here.
      if (failure !== 'rejected') reportError(cause, { operation: 'sync-unlock', step: 'unlockSyncSession' });
      setError(failure === 'rejected' ? t('sync.unlockFailed') : t('sync.genericError'));
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <form className="rounded-xl border bg-card p-6" onSubmit={handleSubmit}>
      <h2 className="font-display text-base font-semibold">{t('sync.lockedTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('sync.lockedBody')}</p>

      <div className="mt-4 flex flex-col gap-2">
        <Label htmlFor="sync-unlock-passphrase">{t('sync.lockedPassphraseLabel')}</Label>
        <Input
          id="sync-unlock-passphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </div>

      {error !== null && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" className="mt-6 w-full sm:w-auto" disabled={isWorking}>
        {isWorking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {isWorking ? t('sync.unlockPending') : t('sync.unlockSubmit')}
      </Button>
    </form>
  );
}
