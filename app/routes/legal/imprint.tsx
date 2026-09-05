import type { MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import { H1, H2, P } from '#app/components/typography';
import PublicWrapper from '#app/components/public-wrapper';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { LEGAL_LAST_UPDATED, formatLegalDate } from './last-updated';
import { LegalPageLinks } from './page-links';
import { OPERATOR } from './operator';

/**
 * The German-law provider identification (Impressum) for the hosted instance.
 *
 * Section 5 DDG binds the OPERATOR of a business-facing telemedia service, and
 * the hosted instance at kenning.altan.fyi is one from the day it answers a
 * request. The duty does not wait for a payment: this product has none.
 *
 * The identifiers are NOT in the translation bundle. They come from
 * `operator.ts`, which explains why, and they are reproduced from two
 * already-shipped, operator-verified imprints in this workspace.
 *
 * Structure follows `openplate/app/routes/legal/imprint.tsx`, including the
 * `Content` split: the prose renders with no data router, while `PublicWrapper`
 * needs one.
 *
 * `break-words` on the article is not cosmetic. German legal compounds
 * ("Verbraucherstreitbeilegung", "Umsatzsteuer-Identifikationsnummer") are
 * longer than a 390 px column at the `H2` size, and without it the heading
 * pushes a horizontal scrollbar onto the whole document. Measured, not assumed:
 * `scrollWidth` was 397 against a 390 client width before this.
 *
 * No Section 18(2) MStV section. That duty attaches to journalistic-editorial
 * content offered to the public. This site publishes a dictionary and
 * machine-written study notes, not articles. If editorial content is ever
 * added, the section has to come back.
 */
export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'legal:meta.imprintTitle') },
  { name: 'robots', content: 'noindex, follow' },
];

export function ImprintContent() {
  const { t, i18n } = useTranslation('legal');

  return (
    <article className="prose prose-zinc dark:prose-invert max-w-none break-words">
      <H1 variant="pageHeader" className="mb-4 text-3xl">
        {t('imprint.title')}
      </H1>

      <P variant="subtle" className="mb-2">
        {t('imprint.intro')}
      </P>
      <P variant="subtle" className="mb-8">
        {t('lastUpdated', { date: formatLegalDate(LEGAL_LAST_UPDATED, i18n.language) })}
      </P>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('imprint.providerHeading')}</H2>
        <address className="not-italic">
          <P className="mt-4">
            {OPERATOR.legalName}
            <br />
            {OPERATOR.street}
            <br />
            {OPERATOR.postalCode} {OPERATOR.city}
            <br />
            {OPERATOR.country}
          </P>
        </address>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('imprint.representedHeading')}</H2>
        <P className="mt-4">
          {t('imprint.managingDirectorLabel')}: {OPERATOR.managingDirector}
        </P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('imprint.registerHeading')}</H2>
        <P className="mt-4">
          {t('imprint.registerNumberLabel')}: {OPERATOR.registerNumber}
          <br />
          {t('imprint.registerCourtLabel')}: {OPERATOR.registerCourt}
        </P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('imprint.vatHeading')}</H2>
        <P className="mt-4">
          {t('imprint.vatLabel')}: {OPERATOR.vatId}
        </P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('imprint.contactHeading')}</H2>
        <P className="mt-4">
          {t('imprint.emailLabel')}: <a href={`mailto:${OPERATOR.imprintEmail}`}>{OPERATOR.imprintEmail}</a>
        </P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('imprint.disputeHeading')}</H2>
        <P className="mt-4">{t('imprint.disputeBody')}</P>
      </section>

      <LegalPageLinks current="imprint" />
    </article>
  );
}

export default function Imprint() {
  return (
    <PublicWrapper>
      <ImprintContent />
    </PublicWrapper>
  );
}
