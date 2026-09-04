import type { Route } from './+types/attribution';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetaFunction } from 'react-router';
import { metaLanguage, metaTitle } from '#app/i18n/meta-title';
import { listSources } from '#app/lib/dictionary/sources.server';
import { getRawDb } from '#drizzle/db';

export const meta: MetaFunction = ({ matches }) => {
  const language = metaLanguage(matches);
  return [
    { title: metaTitle(language, 'attribution.metaTitle') },
    { name: 'description', content: metaTitle(language, 'attribution.metaDescription') },
  ];
};

/**
 * Where a licence's own text lives.
 *
 * A Map rather than an object literal, so the lookup has one shape and an
 * unknown licence is a plain `undefined` instead of a prototype surprise.
 * `LLM-GENERATED` is deliberately absent: it is our own output, so there is no
 * upstream licence to link to, and the card says that in words instead.
 */
const LICENCE_URLS = new Map<string, string>([
  ['CC0-1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  ['CC-BY-2.0-FR', 'https://creativecommons.org/licenses/by/2.0/fr/'],
  ['CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/'],
]);

/** The licence identifier for our own generated content. */
const GENERATED_LICENCE = 'LLM-GENERATED';

/**
 * The STABLE anchor for the generated-content card.
 *
 * Every enrichment panel carries a credit link to `/attribution#llm-generated`,
 * and that link must not depend on whatever slug the generated source row
 * happens to hold. The card keeps its slug anchor as well, so a credit written
 * against either address lands on it.
 */
const GENERATED_ANCHOR = 'llm-generated';

/** One source card's data, with the timestamp already reduced to a stable string. */
interface SourceCard {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  licence: string;
  attribution: string;
  /** ISO calendar date, or `null`. */
  importedOn: string | null;
  version: string | null;
}

/**
 * Attribution for CC BY sources is a licence obligation, so this page is a
 * legal surface, not a credits roll. It reads the sources table directly.
 *
 * The import timestamp is reduced to an ISO calendar date HERE rather than
 * formatted in the component. A locale-formatted date is rendered against the
 * server's timezone first and the reader's second, which is a hydration
 * mismatch waiting on the first reader outside UTC.
 */
export async function loader() {
  const rows = await listSources(getRawDb());
  const sources: SourceCard[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    licence: row.licence,
    attribution: row.attribution,
    importedOn: row.importedAt === null ? null : row.importedAt.toISOString().slice(0, 10),
    version: row.version,
  }));
  return { sources };
}

/** One labelled line inside a source card. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One source, addressable by `#slug` so a credit link anywhere lands on it. */
function SourceCardView({ source }: { source: SourceCard }) {
  const { t } = useTranslation();
  const licenceUrl = LICENCE_URLS.get(source.licence);
  const isGenerated = source.licence === GENERATED_LICENCE;

  return (
    // `scroll-mt-24` clears the sticky app header, so a `#slug` jump lands on
    // the card's title rather than behind the chrome.
    <section id={source.slug} className="scroll-mt-24 rounded-lg border bg-card p-4 shadow-sm">
      {/* `scroll-mt-24` again, because the jump target is this element rather
          than the card, and the sticky app header would otherwise cover the
          title the reader was sent here to read. */}
      {isGenerated && <span id={GENERATED_ANCHOR} className="block scroll-mt-24" aria-hidden="true" />}
      <h2 className="font-display text-base font-semibold">{isGenerated ? t('attribution.generatedTitle') : source.name}</h2>
      {isGenerated && <p className="mt-1 text-sm text-muted-foreground">{t('attribution.generatedBody')}</p>}
      <dl className="mt-3 space-y-1">
        <Field label={t('attribution.licenceLabel')}>
          {licenceUrl === undefined && source.licence}
          {licenceUrl !== undefined && (
            <a href={licenceUrl} rel="noreferrer" target="_blank" className="text-primary underline-offset-2 hover:underline">
              {source.licence}
            </a>
          )}
        </Field>
        <Field label={t('attribution.attributionLabel')}>{source.attribution}</Field>
        {source.url !== null && (
          <Field label={t('attribution.urlLabel')}>
            <a href={source.url} rel="noreferrer" target="_blank" className="text-primary underline-offset-2 hover:underline">
              {source.url}
            </a>
          </Field>
        )}
        <Field label={t('attribution.importedAtLabel')}>
          <span className="tabular-nums">{source.importedOn ?? t('attribution.notImported')}</span>
        </Field>
        {source.version !== null && <Field label={t('attribution.versionLabel')}>{source.version}</Field>}
      </dl>
    </section>
  );
}

export default function AttributionRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { sources } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">{t('attribution.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('attribution.intro')}</p>
      </div>
      {sources.length === 0 && (
        <div className="surface-brand-soft rounded-xl border border-dashed p-6">
          <p className="text-sm text-muted-foreground">{t('attribution.empty')}</p>
        </div>
      )}
      {sources.length > 0 && (
        <div className="flex flex-col gap-3">
          {sources.map((source) => (
            <SourceCardView key={source.id} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}
