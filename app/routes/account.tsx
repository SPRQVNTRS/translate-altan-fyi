import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import type { Route } from './+types/account';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { getAccountSession } from '#app/services/account-session.server';
import { readLatestBlobSizeBytes } from '#app/services/e2ee-blob-usage.server';
import { listAccountDevicesForRequest, type AccountDeviceSummary } from '#app/services/account-devices.server';
import { DeviceList } from '#app/components/account/device-list';
import { ExportDataButton } from '#app/components/account/export-data-button';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

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
 * ONLY THE HANDLE, THE STORED BYTE COUNT AND THE DEVICE LIST CROSS THE
 * BOUNDARY. Not the account id, not the family id of the current device beyond
 * the `current` boolean the server already decided, and above all not the
 * tokens the session cookie carries. A loader's return value is serialized into
 * the HTML and readable by any script on the page, which is the precise
 * property the httpOnly cookie exists to deny. The byte count is safe to add
 * because it is a length, not content: the server holds no key for those bytes
 * and this number is the only fact about them it can state. A device entry is
 * safe for the same kind of reason: a family id is a handle for a revoke, and
 * presenting one proves nothing.
 *
 * A SIGNED-OUT VISITOR IS NOT QUERIED AT ALL, for either read. There is no
 * account to attribute a blob or a session to, so both are skipped rather than
 * run and discarded.
 *
 * @returns the signed-in handle, its stored blob size and its live devices.
 *   `null`, `null` and an empty list for a signed-out visitor.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<{
  handle: string | null;
  vaultSizeBytes: number | null;
  devices: AccountDeviceSummary[];
}> {
  const session = await getAccountSession(request);
  if (!session) return { handle: null, vaultSizeBytes: null, devices: [] };

  const [vaultSizeBytes, devices] = await Promise.all([
    readLatestBlobSizeBytes(session.accountId),
    listAccountDevicesForRequest({ request, accountId: session.accountId }),
  ]);
  return { handle: session.handle, vaultSizeBytes, devices };
}

/**
 * A byte count as a short, language-aware string.
 *
 * Below one kibibyte the count is reported exactly, because a rounded
 * `0.0 KiB` at that scale hides the difference between a small vault and an
 * empty one. Above it the value is scaled to KiB, then MiB, at one decimal.
 *
 * THE UNIT IS A LITERAL SUFFIX, not copy. A unit symbol is the same in every
 * language this app serves, and `Intl.NumberFormat`'s `unit` style offers no
 * binary prefixes anyway. Only the NUMBER is localized, which is the part that
 * actually differs: `1,024.0` in English against `1.024,0` in German.
 *
 * @param input.bytes the count to format.
 * @param input.language the active i18n language tag.
 * @returns for example `840 B`, `12.4 KiB` or `3.1 MiB`.
 */
function formatByteSize(input: { bytes: number; language: string }): string {
  const { bytes, language } = input;
  if (bytes < BYTES_PER_KIB) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(bytes)} B`;
  }

  const scaled = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < BYTES_PER_MIB) return `${scaled.format(bytes / BYTES_PER_KIB)} KiB`;
  return `${scaled.format(bytes / BYTES_PER_MIB)} MiB`;
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
  const { t, i18n } = useTranslation();
  const { handle, vaultSizeBytes, devices } = loaderData;
  const vaultSizeText =
    vaultSizeBytes === null
      ? t('account.vaultSizeEmpty')
      : formatByteSize({ bytes: vaultSizeBytes, language: i18n.language });

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
        {handle !== null && (
          <div className="mt-4">
            <div className="text-xs text-muted-foreground">{t('account.vaultSizeLabel')}</div>
            <div className="mt-1 text-sm">{vaultSizeText}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t('account.vaultSizeHint')}</p>
          </div>
        )}
      </div>

      {/* Signed in only: a signed-out visitor has no sessions to list, and the
          empty card would read as an invitation to make some. */}
      {handle !== null && <DeviceList devices={devices} />}

      {/* Always, in both states. What this exports is the DEVICE'S data, which
          exists with or without an account. */}
      <ExportDataButton />
    </div>
  );
}
