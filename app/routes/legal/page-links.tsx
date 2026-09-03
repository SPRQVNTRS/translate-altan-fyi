import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

/** Which of the three documents the reader is already on. */
export type LegalPage = 'imprint' | 'privacy' | 'terms';

/** One document, its path and the catalogue key of its label. */
const PAGES = [
  { page: 'imprint', to: '/legal/imprint', labelKey: 'links.imprint' },
  { page: 'privacy', to: '/legal/privacy', labelKey: 'links.privacy' },
  { page: 'terms', to: '/legal/terms', labelKey: 'links.terms' },
] as const satisfies readonly { page: LegalPage; to: string; labelKey: string }[];

/**
 * The three legal documents, cross-linked from each of them.
 *
 * The app shell is not the place for these links: it is a bottom tab bar and a
 * sidebar of things a person uses, and a privacy policy is not one of them.
 * `/settings` carries the entry point, and once a reader is inside a document
 * this strip gets them to the other two without going back through settings.
 *
 * The current page is rendered as plain text rather than as a link to itself.
 */
export function LegalPageLinks({ current }: { current: LegalPage }) {
  const { t } = useTranslation('legal');

  return (
    <nav aria-label={t('links.title')} className="mt-12 border-t pt-6 text-sm text-muted-foreground">
      <p className="mb-3">{t('links.body')}</p>
      <ul className="flex list-none flex-wrap gap-x-6 gap-y-2 pl-0">
        {PAGES.map(({ page, to, labelKey }) => (
          <li key={page}>
            {page === current ?
              <span aria-current="page" className="font-medium text-foreground">
                {t(labelKey)}
              </span>
            : <Link to={to} className="underline underline-offset-4 hover:text-foreground">
                {t(labelKey)}
              </Link>
            }
          </li>
        ))}
      </ul>
    </nav>
  );
}
