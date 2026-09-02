import type { MetaFunction } from 'react-router';
import { SyncLoginForm } from '#app/components/sync/sync-login-form';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [{ title: metaTitle(language, 'sync.loginMetaTitle') }];
};

/**
 * Signing a second device in.
 *
 * No loader and no action, for the same reason as `/sync/setup`: the
 * passphrase is stretched in the browser and only the derived hash is sent.
 */
export default function SyncLoginRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <SyncLoginForm />
    </div>
  );
}
