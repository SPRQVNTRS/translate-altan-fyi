import * as React from 'react';

import { cn } from '#app/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  // `rounded-2xl` is the dominant card radius for primary content cards (it
  // replaced `rounded-lg`). Chips and badges stay pill-shaped (`rounded-full`),
  // and this rule does not touch them. Cards rest at `shadow-sm` and never
  // heavier. Hover elevation (`hover:shadow-md` / `hover:shadow-lg`) is a
  // per-instance opt-in for interactive list cards, not a Card-wide default.
  <div ref={ref} className={cn('rounded-2xl border bg-card text-card-foreground shadow-sm', className)} {...props} />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    // Card titles are `text-lg font-semibold`. Unsized, they inherit the body
    // text size, which makes a headline (a word, a list name, a section label)
    // read flat against its own body copy. Callers that want another size still
    // override through `className`.
    //
    // Titles also carry the display serif (`font-display`, Fraunces: see
    // app.css). This is the highest-leverage place to spread the brand voice
    // past the hero, because Search, Lists, History and Settings all render card
    // titles. It is safe HERE and nowhere near a live figure: a card TITLE is
    // always a label ("Recent searches", "Your lists", a headword), while
    // counts and dates live in card CONTENT and stay in Inter with
    // `tabular-nums`. The Fraunces subset has no tabular figures, so digits set
    // in it would jitter in width as they update.
    <div
      ref={ref}
      className={cn('font-display text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
