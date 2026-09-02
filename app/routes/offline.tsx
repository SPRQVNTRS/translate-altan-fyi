import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { Button } from '#app/components/ui/button';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'offline.metaTitle') },
    { name: 'description', content: metaTitle(language, 'offline.metaDescription') },
  ];
};

/**
 * The fallback the service worker serves when a document navigation fails with
 * no connection. It has NO loader and NO action on purpose: the worker replays
 * a precached copy of this HTML, so anything that needed the network would turn
 * the offline page itself into an offline failure.
 *
 * It sits inside the `_app` layout so it carries the same chrome as the other
 * precached shell routes. Landing on a bare page with no nav would read as the
 * app having crashed, when in fact every screen already visited still works.
 *
 * Translations are bundled inline (see `app/i18n/i18n.ts`), so this renders in
 * the visitor's language while genuinely offline, with no catalog fetch to
 * fail. `meta()` goes through the pure `meta-title` seam, which degrades to the
 * default language when the root match is absent.
 */
export default function OfflineRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="surface-brand-soft flex flex-col items-start rounded-xl border border-dashed p-6">
        <WifiOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="mt-3 font-display text-base font-semibold">{t('offline.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('offline.body')}</p>
        <Button type="button" className="mt-4" onClick={() => window.location.reload()}>
          {t('offline.retry')}
        </Button>
      </div>
    </div>
  );
}
