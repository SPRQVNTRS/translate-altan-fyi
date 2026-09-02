import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'Settings' },
  { name: 'description', content: 'Choose your languages and how the app looks.' },
];

export default function SettingsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>

      <div className="rounded-xl border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          Your language pair and the light or dark theme will live here. The theme switch already works, in the top
          right of the header.
        </p>
      </div>
    </div>
  );
}
