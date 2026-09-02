import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';

// `meta()` runs outside the React tree, so it has no `t`. It goes through the
// pure `meta-title` seam instead, which reads the language off the ROOT loader
// rather than the process-wide i18next singleton. See that module for why the
// singleton is a cross-request bug here.
export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'search.metaTitle') },
    { name: 'description', content: metaTitle(language, 'search.metaDescription') },
  ];
};

/**
 * The home screen. The hero card is the one `.surface-brand` on this screen, a
 * design rule, so nothing else here may carry the brand wash.
 *
 * Placeholder only: no loader, no action, no state. The field and the button
 * are the shape of the search, not a working one.
 */
export default function SearchRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="surface-brand rounded-xl border p-5">
        <label htmlFor="search-word" className="text-sm font-medium">
          {t('search.fieldLabel')}
        </label>
        <div className="mt-2 flex gap-2">
          <Input id="search-word" type="text" placeholder={t('search.placeholder')} disabled />
          <Button type="button" disabled>
            {t('search.submit')}
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{t('search.note')}</p>
      </div>
    </div>
  );
}
