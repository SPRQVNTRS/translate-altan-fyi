/**
 * The signed-in devices of an account, and the control that ends one of them.
 *
 * A DEVICE IS A TOKEN FAMILY, and the app has no name for one because it never
 * asked for one. Nothing in the sign-in flow collects a device label, and
 * guessing one from a user-agent string would be a fiction the browser is free
 * to change under us. So the label is the first characters of the family id,
 * set in `font-mono` because that is what makes a random string comparable at a
 * glance against the same string on the other device.
 *
 * THE REVOKE IS A `DELETE` WITH A JSON BODY TO A RESOURCE ROUTE, which is why
 * this does not use `app/components/confirm-action.tsx`. That component submits
 * a `FormData` `POST` through `useFetcher` to a route action, and there is no
 * shape of it that sends this request. It does use the same `AlertDialog`
 * primitives, in the same arrangement, so the two dialogs look and behave
 * alike.
 *
 * CLIENT ONLY, AND NOTHING SERVER-SIDE IS IMPORTED. The device list arrives as
 * a prop from `/account`'s loader; the only value that crosses from a
 * `.server` module is the `AccountDeviceSummary` TYPE, which is erased at
 * compile time.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useRevalidator } from 'react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import type { AccountDeviceSummary } from '#app/services/account-devices.server';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#app/components/ui/alert-dialog';
import { Button } from '#app/components/ui/button';

/** How much of a family id is enough to tell two devices apart without turning the row into a hex dump. */
const LABEL_LENGTH = 8;

/** Where a device that has just signed ITSELF out goes. That route is what destroys the browser cookie. */
const LOGOUT_PATH = '/logout';

export interface DeviceListProps {
  devices: AccountDeviceSummary[];
}

export function DeviceList({ devices }: DeviceListProps) {
  const { t } = useTranslation();

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('account.devicesTitle')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('account.devicesBody')}</p>
      {devices.length === 0 && <p className="mt-4 text-sm text-muted-foreground">{t('account.devicesEmpty')}</p>}
      {devices.length > 0 && (
        <ul className="mt-4 divide-y">
          {devices.map((device) => (
            <DeviceRow key={device.familyId} device={device} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One device, and its confirmation dialog.
 *
 * Each row owns its own dialog and pending state, so revoking one device never
 * puts a spinner on another.
 */
function DeviceRow({ device }: { device: AccountDeviceSummary }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [isOpen, setIsOpen] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    setIsRevoking(true);
    try {
      await revokeDevice(device.familyId);
      toast.success(t('account.revokeTitle'));
      setIsOpen(false);
      // Signing THIS browser out ends with the cookie, which only `/logout`
      // can clear: the API route revokes the family server-side and
      // deliberately leaves the cookie alone. Any other device just needs the
      // list read again.
      if (device.current) {
        await navigate(LOGOUT_PATH);
        return;
      }
      await revalidator.revalidate();
    } catch {
      toast.error(t('sync.genericError'));
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <li className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{device.familyId.slice(0, LABEL_LENGTH)}</span>
          {device.current && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {t('account.deviceCurrent')}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
          {t('account.deviceCreated')} {formatInstant({ iso: device.createdAt, language: i18n.language })}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {t('account.deviceLastSeen')} {formatInstant({ iso: device.lastSeenAt, language: i18n.language })}
        </div>
      </div>

      <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            {t('account.deviceRevoke')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.revokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('account.revokeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRevoking}>{t('account.revokeCancel')}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleConfirm} disabled={isRevoking}>
              {isRevoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('account.revokeConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/**
 * Ends one device's session.
 *
 * The endpoint answers `200` for an unknown or foreign family id as well, so
 * there is nothing here to branch on: a non-`ok` response means the request
 * itself failed, and that is the only case worth telling the user about.
 */
async function revokeDevice(familyId: string): Promise<void> {
  const response = await fetch('/api/v1/auth/devices', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ familyId }),
  });
  if (!response.ok) throw new Error(`Could not revoke the device: ${response.status}`);
}

/**
 * An ISO-8601 instant as a short, language-aware date and time.
 *
 * The same localization rule `/account` already applies to its byte count:
 * only the value is translated, and it is translated with `Intl` rather than
 * with a copy string, because a date format is a property of the language and
 * not of this app's voice.
 */
function formatInstant(input: { iso: string; language: string }): string {
  const formatter = new Intl.DateTimeFormat(input.language, { dateStyle: 'medium', timeStyle: 'short' });
  return formatter.format(new Date(input.iso));
}
