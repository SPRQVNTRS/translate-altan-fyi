import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { SearchResults } from '#app/components/search-results';
import type { LandingExample } from '#app/lib/dictionary/landing-example';

/**
 * The pitch under the search box, for a visitor who has typed nothing yet.
 *
 * It is part of the search route rather than a page of its own. A separate
 * marketing route would mean a stranger lands somewhere the product is
 * described and then has to click into the product; here the first thing on
 * screen is the search box, and this section explains what pressing it does.
 *
 * Three sentences and one real result, in that order: what a search returns,
 * what lists are for, and what the server can and cannot read. The privacy
 * paragraph carries BOTH halves. Selling the encrypted personal zone while
 * going quiet about the word travelling to the server would be the flattering
 * version, and the privacy policy this links to says the same two things.
 *
 * The example card is rendered by `SearchResults`, the component a real search
 * uses, from a real row of the dictionary. It is server rendered, so it is in
 * the HTML a crawler and a curl see.
 */
export function Landing({ example }: { example: LandingExample | null }) {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-lg font-semibold">{t('landing.heading')}</h2>
      <ul className="flex list-none flex-col gap-2 pl-0 text-sm text-muted-foreground">
        <li>{t('landing.search')}</li>
        <li>{t('landing.lists')}</li>
        <li>
          {t('landing.privacy')} {t('landing.privacyPlaintext')}{' '}
          <Link to="/legal/privacy" className="underline underline-offset-4 hover:text-foreground">
            {t('landing.privacyLink')}
          </Link>
        </li>
      </ul>

      {example !== null && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('landing.exampleHeading', { word: example.word })}</h3>
          <SearchResults hits={[example.hit]} to={example.to} />
        </div>
      )}
    </section>
  );
}
