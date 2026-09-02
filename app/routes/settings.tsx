import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'Settings' },
  { name: 'description', content: 'Choose your languages and how the app looks.' },
];

export default function SettingsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">Languages and theme</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your language pair and the light or dark theme will live here. The theme switch already works, in the top
          right of the header.
        </p>
      </div>
    </div>
  );
}
