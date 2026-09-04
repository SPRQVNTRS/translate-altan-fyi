import * as React from 'react';

import { cn } from '#app/lib/utils';

/**
 * The multi-line sibling of `Input`, with the same border, ring and disabled
 * treatment so a form can mix the two without them reading as two design
 * systems.
 *
 * `field-sizing-content` lets the box grow with what is typed, bounded by
 * `min-h`, so a one-word lookup does not sit in a half-empty panel and a
 * pasted sentence does not hide behind a scrollbar. Browsers without the
 * property simply keep the `min-h` box, which is the old behaviour.
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input field-sizing-content min-h-24 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
