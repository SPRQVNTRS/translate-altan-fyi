import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import type { Route } from './+types/account';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { getAccountSession } from '#app/services/account-session.server';
import { readLatestBlobSizeBytes } from '#app/services/e2ee-blob-usage.server';

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
 * ONLY THE HANDLE AND THE STORED BYTE COUNT CROSS THE BOUNDARY. Not the
 * account id, and above all not the tokens the session cookie carries. A
 * loader's return value is serialized into the HTML and readable by any script
 * on the page, which is the precise property the httpOnly cookie exists to
 * deny. The byte count is safe to add because it is a length, not content: the
 * server holds no key for those bytes and this number is the only fact about
 * them it can state.
 *
 * A SIGNED-OUT VISITOR IS NOT QUERIED AT ALL. There is no account to attribute
 * a blob to, so the read is skipped rather than run and discarded.
 *
 * @returns the signed-in handle and its stored blob size, or `null` for each.
 */
export async function loader({
  request,
}: Route.LoaderArgs): Promise<{ handle: string | null; vaultSizeBytes: number | null }> {
  const session = await getAccountSession(request);
  if (!session) return { handle: null, vaultSizeBytes: null };
  return { handle: session.handle, vaultSizeBytes: await readLatestBlobSizeBytes(session.accountId) };
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
  const { handle, vaultSizeBytes } = loaderData;
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
    </div>
  );
}
