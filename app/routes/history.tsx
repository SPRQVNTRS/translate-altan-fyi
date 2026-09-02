import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'History' },
  { name: 'description', content: 'Every word you look up, kept so you can find it again.' },
];

export default function HistoryRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">History</h1>

      <div className="surface-brand-soft rounded-xl border border-dashed p-6">
        <p className="text-sm text-muted-foreground">
          Every word you look up lands here, so you can find it again. Your first search starts the list.
        </p>
      </div>
    </div>
  );
}
