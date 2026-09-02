import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { LanguageToggle } from '#app/components/language-toggle';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'settings.metaTitle') },
    { name: 'description', content: metaTitle(language, 'settings.metaDescription') },
  ];
};

export default function SettingsRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('settings.appearanceTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.appearanceBody')}</p>
      </div>
      {/* The app language is a real, working control, so it gets its own card
          rather than a line inside the one above, which describes things that
          are not built yet. */}
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('settings.languageTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.languageBody')}</p>
        <div className="mt-4">
          <LanguageToggle />
        </div>
      </div>
    </div>
  );
}
