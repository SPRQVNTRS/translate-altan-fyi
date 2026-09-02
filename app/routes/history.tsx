import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'history.metaTitle') },
    { name: 'description', content: metaTitle(language, 'history.metaDescription') },
  ];
};

export default function HistoryRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="surface-brand-soft rounded-xl border border-dashed p-6">
        <h2 className="font-display text-base font-semibold">{t('history.emptyTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('history.emptyBody')}</p>
      </div>
    </div>
  );
}
