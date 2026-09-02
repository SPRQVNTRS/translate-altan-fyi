import type { MetaFunction } from 'react-router';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';

export const meta: MetaFunction = () => [
  { title: 'Search' },
  { name: 'description', content: 'Look up a word or a phrase and get a translation you can keep.' },
];

/**
 * The home screen. The hero card is the one `.surface-brand` on this screen, a
 * design rule, so nothing else here may carry the brand wash.
 *
 * Placeholder only: no loader, no action, no state. The field and the button
 * are the shape of the search, not a working one.
 */
export default function SearchRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Search</h1>

      <div className="surface-brand rounded-xl border p-5">
        <label htmlFor="search-word" className="text-sm font-medium">
          Word or phrase
        </label>
        <div className="mt-2 flex gap-2">
          <Input id="search-word" type="text" placeholder="Type a word, for example: Feierabend" disabled />
          <Button type="button" disabled>
            Search
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          The dictionary is not connected yet, so the field is still resting. Today this screen shows you where the
          search will live, and the shape of the answer you will get back, a translation, a short explanation and a few
          example sentences.
        </p>
      </div>
    </div>
  );
}
