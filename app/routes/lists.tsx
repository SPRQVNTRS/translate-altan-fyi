import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'Lists' },
  { name: 'description', content: 'The words you saved, grouped into lists you can learn from.' },
];

export default function ListsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="surface-brand-soft rounded-xl border border-dashed p-6">
        <h2 className="font-display text-base font-semibold">Saved words</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your saved words will collect here. Save one from a search result to start a list.
        </p>
      </div>
    </div>
  );
}
