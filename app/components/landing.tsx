import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { buttonVariants } from '#app/components/ui/button';
import { SearchResults } from '#app/components/search-results';
import type { LandingExample } from '#app/lib/dictionary/landing-example';

/**
 * The hero, for a visitor with no account.
 *
 * IT IS A PLAIN BLOCK, NOT A CARD. A bordered box spanning the full column
 * above the two panes read as a third pane, and the widths jumped between full
 * and half twice on the way down the page.
 *
 * ITS HEADING IS AN `h2`, NOT AN `h1`. The app shell's header already renders
 * the route title as the page's `h1`, and a browser walk found both on the home
 * screen. This is the section heading under that one; the type scale is the
 * hero's either way.
 *
 * The primary action is a real button and the secondary one is a link, so the
 * two doors are not weighted the same: a reader who is here without an account
 * almost always needs the first one.
 *
 * NOTHING RENDERS THIS FOR A SIGNED-IN READER. The caller decides that, and
 * `search.tsx` is the only caller.
 */
export function LandingDoors() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">{t('landing.heading')}</h2>
      <p className="max-w-prose text-base text-muted-foreground">{t('landing.doorsBody')}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Link to="/sign-up" className={buttonVariants()}>
          {t('account.createAction')}
        </Link>
        <Link to="/sign-in" className="text-sm underline underline-offset-4 hover:text-foreground">
          {t('account.signInAction')}
        </Link>
      </div>
    </div>
  );
}

/**
 * One worked example, for the OUTPUT PANE of an empty search.
 *
 * `search.tsx` hands this to `SearchPanes` as its `emptyPane`, so with nothing
 * typed the right-hand column holds a real answer instead of a hole beside the
 * input box. On a phone the panes stack and it sits under the box, which is
 * where an answer belongs there too.
 *
 * IT IS FOR EVERYBODY, signed in or not. It is a demonstration rather than a
 * pitch: the same `SearchResults` component a real search renders, fed a real
 * row of the dictionary, server rendered so a crawler and a curl see it.
 */
export function LandingExampleCard({ example }: { example: LandingExample }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t('landing.exampleHeading', { word: example.word })}</h3>
      <SearchResults hits={[example.hit]} to={example.to} />
    </div>
  );
}

/**
 * The one line under the panes, for a visitor with no account.
 *
 * THE PITCH LIST IS GONE. Three sentences describing the product, under a hero
 * that already describes it, said the same thing a third time at a third width.
 * What survives is the half that is not a pitch: the privacy paragraph, which
 * carries BOTH halves. Selling the encrypted personal zone while going quiet
 * about the word travelling to the server would be the flattering version, and
 * the privacy policy this links to says the same two things.
 */
export function LandingPrivacyNote() {
  const { t } = useTranslation();

  return (
    <p className="text-sm text-muted-foreground">
      {t('landing.privacy')} {t('landing.privacyPlaintext')}{' '}
      <Link to="/legal/privacy" className="underline underline-offset-4 hover:text-foreground">
        {t('landing.privacyLink')}
      </Link>
    </p>
  );
}
