import type { MetaFunction } from 'react-router';
import { SyncSetupFlow } from '#app/components/sync/sync-setup-flow';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'sync.setupMetaTitle') },
    { name: 'description', content: metaTitle(language, 'sync.setupMetaDescription') },
  ];
};

/**
 * Setting sync up.
 *
 * No loader and no action, on purpose. Every value this screen handles is a
 * secret that must not leave the browser, so the work happens in client code
 * and reaches the service through `fetch`. A route action would run on the
 * server, which is precisely where none of this may go.
 */
export default function SyncSetupRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <SyncSetupFlow />
    </div>
  );
}
