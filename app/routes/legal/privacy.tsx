import type { MetaFunction } from 'react-router';
import { useTranslation } from 'react-i18next';

import { H1, H2, P } from '#app/components/typography';
import PublicWrapper from '#app/components/public-wrapper';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { LEGAL_LAST_UPDATED, formatLegalDate } from './last-updated';
import { LegalPageLinks } from './page-links';
import { OPERATOR } from './operator';

/**
 * The privacy policy, and the one page where a vague sentence is a liability.
 *
 * THE ACCOUNT IS PLAIN NOW, AND SO IS THIS PAGE. Since ADR-0011 there is no
 * encrypted personal zone to describe. Anonymous use still keeps everything on
 * the device, but an account means the operator holds an address, a password
 * hash and a READABLE copy of the lists, notes, revision progress and history.
 * Section 8 says that in the plain words a reader needs, including the sentence
 * about not writing into a note what you would not want the operator to see.
 *
 * EVERY CLAIM HERE WAS READ OUT OF THE CODE, NOT INFERRED FROM THE PLAN:
 *   - the account row: `drizzle/schema/users.ts`, an email, a bcrypt hash and
 *     the verification and password-change timestamps.
 *   - the single-use mailed links, stored as SHA-256 hashes: `user_tokens` in
 *     the same schema, and `app/services/auth.server.ts`.
 *   - the readable sync copy: `sync_blobs.payload`, a `jsonb` column.
 *   - the device's own store: `app/lib/local-store/`.
 *   - history capped on the device: `HISTORY_MAX_ENTRIES` (500) and
 *     `HISTORY_MAX_AGE_DAYS` (90) in `app/lib/local-store/schema.ts`.
 *   - the two mails and nothing else: `app/services/email.server.ts`.
 *   - the provider: `app/lib/llm/catalog.ts`, Gemini routed over OpenRouter.
 *   - what the provider receives: `app/lib/enrichment/job-payload.ts`, a
 *     `z.strictObject` with a headword and a language pair and no user field.
 *   - the AI Act label: `app/lib/ai-disclosure.ts`.
 *   - voice: `app/routes/api.v1.transcribe.ts` stores no clip.
 *   - the abuse counters: `app/lib/abuse/rate-limit.server.ts` (peppered hash,
 *     hourly counts) and `app/lib/abuse/budget.server.ts` (daily spend rows).
 *
 * A change to any of those files is a change to this page.
 *
 * TYPOGRAPHY: `H2 variant="sectionHeader"` rather than the `default` variant
 * the ts-factory-stack boilerplate used. `default` is `text-3xl`, which is
 * LARGER than the page's own `h1` and turns fifteen section headings into
 * fifteen competing titles. A legal document wants a readable column and a
 * clear hierarchy, not a poster.
 */
export const meta: MetaFunction = ({ matches }) => [
  { title: metaTitle(metaLanguage(matches), 'legal:meta.privacyTitle') },
];

/**
 * Whether THIS instance actually measures anything.
 *
 * TRUE SINCE M175/03. `app/components/site/matomo.tsx` carries the tag and
 * `app/root.tsx` renders it on the production host, so `s11BodyMatomo` is now
 * the honest sentence and `s11BodyNone` would be a false one. A self-hosted
 * install that drops the tag flips this back in the same change.
 *
 * The rule this encodes, taken from openplate's own correction: a policy that
 * describes measurement which is switched off is a false statement in a legally
 * operative document, even though it over-discloses rather than under-discloses.
 * The reverse is worse, and it is what this constant now asserts against:
 * measurement that runs while the page denies it.
 */
const ANALYTICS_ENABLED = true;

export function PrivacyContent() {
  const { t, i18n } = useTranslation('legal');

  return (
    <article className="prose prose-zinc dark:prose-invert max-w-none break-words">
      <H1 variant="pageHeader" className="mb-4 text-3xl">
        {t('privacy.title')}
      </H1>

      <P variant="subtle" className="mb-8">
        {t('lastUpdated', { date: formatLegalDate(LEGAL_LAST_UPDATED, i18n.language) })}
      </P>

      <P className="mb-8">{t('privacy.lead')}</P>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s1Heading')}</H2>
        <ul className="mt-4">
          <li>{t('privacy.s1Item1')}</li>
          <li>{t('privacy.s1Item2')}</li>
          <li>{t('privacy.s1Item3')}</li>
          <li>{t('privacy.s1Item4')}</li>
          <li>{t('privacy.s1Item5')}</li>
        </ul>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s2Heading')}</H2>
        <P className="mt-4">{t('privacy.s2Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s3Heading')}</H2>
        <P className="mt-4">{t('privacy.s3Body1')}</P>
        <P className="mt-4">{t('privacy.s3Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s4Heading')}</H2>
        <P className="mt-4">{t('privacy.s4Body1')}</P>
        <P className="mt-4">{t('privacy.s4Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s5Heading')}</H2>
        <P className="mt-4">{t('privacy.s5Body1')}</P>
        <P className="mt-4">{t('privacy.s5Body2')}</P>
        <P className="mt-4">{t('privacy.s5Body3')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s6Heading')}</H2>
        <P className="mt-4">{t('privacy.s6Body1')}</P>
        <P className="mt-4">{t('privacy.s6Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s7Heading')}</H2>
        <P className="mt-4">{t('privacy.s7Body1')}</P>
        <P className="mt-4">{t('privacy.s7Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s8Heading')}</H2>
        <P className="mt-4">{t('privacy.s8Body1')}</P>
        <P className="mt-4">{t('privacy.s8Body2')}</P>
        <P className="mt-4">{t('privacy.s8Body3')}</P>
        <P className="mt-4">{t('privacy.s8Body4')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s9Heading')}</H2>
        <P className="mt-4">{t('privacy.s9Body1')}</P>
        <P className="mt-4">{t('privacy.s9Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s10Heading')}</H2>
        <P className="mt-4">{t('privacy.s10Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s11Heading')}</H2>
        <P className="mt-4">{t(ANALYTICS_ENABLED ? 'privacy.s11BodyMatomo' : 'privacy.s11BodyNone')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s12Heading')}</H2>
        <P className="mt-4">{t('privacy.s12Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s13Heading')}</H2>
        <P className="mt-4">{t('privacy.s13Body1')}</P>
        <P className="mt-4">{t('privacy.s13Body2')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s14Heading')}</H2>
        <P className="mt-4">{t('privacy.s14Body')}</P>
      </section>

      <section className="mb-8">
        <H2 variant="sectionHeader">{t('privacy.s15Heading')}</H2>
        <P className="mt-4">{t('privacy.s15Body')}</P>
        <P className="mt-4">
          <a href={`mailto:${OPERATOR.privacyEmail}`}>{OPERATOR.privacyEmail}</a>
        </P>
      </section>

      <LegalPageLinks current="privacy" />
    </article>
  );
}

export default function Privacy() {
  return (
    <PublicWrapper>
      <PrivacyContent />
    </PublicWrapper>
  );
}
