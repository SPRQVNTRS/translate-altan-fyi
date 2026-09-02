import type { MetaFunction } from 'react-router';

export const meta: MetaFunction = () => [
  { title: 'Account' },
  { name: 'description', content: 'Your account, your devices and your saved words.' },
];

/**
 * There are no plans and no payment in this product, so this screen is about
 * the device and the account, never about billing.
 */
export default function AccountRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="rounded-xl border bg-card p-6">
        <h2 className="font-display text-base font-semibold">Your account and devices</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This screen will show the account your words belong to, and the devices signed in to it. The app is free, so
          there is nothing to pay for and no plan to pick.
        </p>
      </div>
    </div>
  );
}
