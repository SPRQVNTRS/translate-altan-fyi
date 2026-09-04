import { useTranslation } from 'react-i18next';
import { Link } from '#app/components/link';
import { buttonVariants } from '#app/components/ui/button';
import { SearchResults } from '#app/components/search-results';
import type { LandingExample } from '#app/lib/dictionary/landing-example';

/**
 * The two doors, for a visitor with no account.
 *
 * IT IS A COMPONENT OF ITS OWN BECAUSE IT DOES NOT SIT WHERE THE PITCH SITS.
 * The doors render ABOVE the two-pane surface and the pitch renders below it,
 * so one component holding both could only ever put the doors where the pitch
 * belongs. That is what shipped first: on a phone the card sat under the whole
 * search pane, off the first screen, and a stranger scrolled past a working
 * demonstration to reach the way in.
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
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-6">
      <h2 className="font-display text-lg font-semibold">{t('landing.heading')}</h2>
      <p className="text-sm text-muted-foreground">{t('landing.doorsBody')}</p>
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
 *
 * THE THREE SENTENCES ARE FOR A STRANGER AND THE EXAMPLE IS FOR EVERYBODY. A
 * signed-in reader has already been sold: the pitch reads as an advertisement
 * for something they hold, and the doors above the pane are gone for them for
 * the same reason. The worked example stays, because it is not a pitch. It is
 * the one thing on an empty home screen that shows the dictionary answering,
 * and it is the same row a search of that word returns.
 */
export function Landing({ example, signedIn }: { example: LandingExample | null; signedIn: boolean }) {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4">
      {!signedIn && (
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
      )}

      {example !== null && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('landing.exampleHeading', { word: example.word })}</h3>
          <SearchResults hits={[example.hit]} to={example.to} />
        </div>
      )}
    </section>
  );
}
