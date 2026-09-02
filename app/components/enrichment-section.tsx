import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '#app/components/ui/skeleton';

/**
 * The three states of the generated explanation and extra examples.
 *
 * `idle` IS ITS OWN STATE, ON PURPOSE.
 *   A section that shows skeletons forever is a lie: skeletons say "this is
 *   arriving", and nothing is arriving, because no request is in flight. The
 *   honest shape for "we could enrich this entry, and have not" is a quiet card
 *   that says so. `pending` is reserved for a request that is genuinely
 *   running, which M171 wires up.
 */
export type EnrichmentState = 'idle' | 'pending' | 'ready';

export interface EnrichmentSectionProps {
  state: EnrichmentState;
  children?: ReactNode;
}

export function EnrichmentSection({ state, children }: EnrichmentSectionProps) {
  const { t } = useTranslation();

  if (state === 'ready') {
    return <section className="rounded-lg border bg-card p-4">{children}</section>;
  }

  if (state === 'pending') {
    return (
      <section className="rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t('enrichment.title')}</h2>
        {/* The spinner vocabulary attaches to the thing that is pending, so the
            skeletons sit under the label rather than floating on the page. */}
        <p className="mt-1 text-sm text-muted-foreground">{t('enrichment.pending')}</p>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-dashed bg-muted/40 p-4">
      <h2 className="font-display text-base font-semibold">{t('enrichment.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('enrichment.idle')}</p>
    </section>
  );
}
