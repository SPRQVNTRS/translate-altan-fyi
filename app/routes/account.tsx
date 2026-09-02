import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'account.metaTitle') },
    { name: 'description', content: metaTitle(language, 'account.metaDescription') },
  ];
};

/**
 * There are no plans and no payment in this product, so this screen is about
 * the device and the account, never about billing.
 */
export default function AccountRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('account.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('account.body')}</p>
      </div>
    </div>
  );
}
