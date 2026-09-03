import type { MetaFunction } from 'react-router';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { H1, H2, P } from '#app/components/typography';
import PublicWrapper from '#app/components/public-wrapper';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { LEGAL_LAST_UPDATED, formatLegalDate } from './last-updated';
import { LegalPageLinks } from './page-links';

/**
 * The terms of use for the hosted instance.
 *
 * NOTHING COMMERCIAL LIVES HERE, AND THAT IS DELIBERATE. Payment was scrapped
 * on 2026-09-01 (see the M175 milestone README). There is no plan, no price, no
 * refund and no subscription clause, because there is no payment to write one
 * about. If money ever enters this product, that is a new document, not an
 * amendment squeezed into section 1.
 *
 * SECTION 5 IS THE ONE WITH A REAL OBLIGATION IN IT. The dictionary is built
 * from CC0 and CC BY sources only (`app/lib/dictionary/licences.ts` is the
 * allowlist that enforces it), and the CC BY half carries an attribution
 * requirement that this document PASSES THROUGH to anyone reusing the content.
 * We cannot waive it, so the terms say so and point at `/attribution`, which
 * renders every source, its licence and its version from the database.
 *
 * The party is the legal person in `operator.ts`, named on the imprint page and
 * linked from the lead, never a product name.
 */
export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'legal:meta.termsTitle') },
];

export function TermsContent() {
  const { t, i18n } = useTranslation('legal');

  return (
    <article className="prose prose-zinc dark:prose-invert max-w-none break-words">
      <H1 variant="pageHeader" className="mb-4 text-3xl">
        {t('terms.title')}
      </H1>

      <P variant="subtle" className="mb-8">
        {t('lastUpdated', { date: formatLegalDate(LEGAL_LAST_UPDATED, i18n.language) })}
      </P>

      <P className="mb-8">{t('terms.lead')}</P>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s1Heading')}</H2>
        <P className="mt-4">{t('terms.s1Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s2Heading')}</H2>
        <P className="mt-4">{t('terms.s2Body1')}</P>
        <P className="mt-4">{t('terms.s2Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s3Heading')}</H2>
        <P className="mt-4">{t('terms.s3Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s4Heading')}</H2>
        <P className="mt-4">{t('terms.s4Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s5Heading')}</H2>
        <P className="mt-4">{t('terms.s5Body1')}</P>
        <P className="mt-4">{t('terms.s5Body2')}</P>
        <P className="mt-4">
          <Link to="/attribution">{t('terms.attributionLink')}</Link>
        </P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s6Heading')}</H2>
        <P className="mt-4">{t('terms.s6Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s7Heading')}</H2>
        <P className="mt-4">{t('terms.s7Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s8Heading')}</H2>
        <P className="mt-4">{t('terms.s8Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s9Heading')}</H2>
        <P className="mt-4">{t('terms.s9Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s10Heading')}</H2>
        <P className="mt-4">{t('terms.s10Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('terms.s11Heading')}</H2>
        <P className="mt-4">{t('terms.s11Body')}</P>
      </section>

      <LegalPageLinks current="terms" />
    </article>
  );
}

export default function Terms() {
  return (
    <PublicWrapper>
      <TermsContent />
    </PublicWrapper>
  );
}
