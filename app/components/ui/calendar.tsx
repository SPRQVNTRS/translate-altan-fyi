import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker, type ChevronProps, type DayPickerProps } from 'react-day-picker';

import { cn } from '#app/lib/utils';
import { buttonVariants } from '#app/components/ui/button';

export type CalendarProps = DayPickerProps;

/**
 * v10's single `components.Chevron` renderer (it replaced v8's
 * `IconLeft`/`IconRight` pair). It is defined at module scope, and referenced
 * through a module-scope `components` object, so react-day-picker sees the
 * same component identity on every render of `Calendar`.
 */
function CalendarChevron({ orientation, className, size }: ChevronProps) {
  return orientation === 'left' ?
      <ChevronLeft className={cn('size-4', className)} size={size} />
    : <ChevronRight className={cn('size-4', className)} size={size} />;
}

const CALENDAR_COMPONENTS = { Chevron: CalendarChevron };

/**
 * shadcn-style wrapper around react-day-picker v10. v10 reworked the theming
 * API from v8's flat classname list to the `UI`/`DayFlag`/`SelectionState`
 * enum keys (see `react-day-picker`'s `UI.d.ts`) and replaced the old
 * `components={{ IconLeft, IconRight }}` pair with a single `components.Chevron`
 * renderer. The shadcn v8 snippet does not drop in as-is, so this mapping was
 * built directly against the installed v10.0.1 types rather than copied.
 * The selected day gets the app's primary colour. Today gets a subtle ring
 * rather than a filled background, so "today" and "selected" stay visually
 * distinct.
 */
function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-2',
        month: 'flex flex-col gap-4',
        month_caption: 'flex justify-center pt-1 relative items-center w-full',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center justify-between absolute inset-x-0 top-0',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-muted-foreground w-9 rounded-md text-[0.8rem] font-normal',
        week: 'flex w-full mt-2',
        day: 'relative p-0 text-center text-sm focus-within:relative focus-within:z-20',
        day_button: cn(buttonVariants({ variant: 'ghost' }), 'size-9 p-0 font-normal aria-selected:opacity-100'),
        range_start: 'day-range-start',
        range_end: 'day-range-end',
        selected:
          '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground [&>button]:focus:bg-primary [&>button]:focus:text-primary-foreground',
        today: '[&>button]:ring-2 [&>button]:ring-primary/50 [&>button]:font-semibold',
        outside: 'text-muted-foreground opacity-50',
        disabled: 'text-muted-foreground opacity-40 line-through',
        hidden: 'invisible',
        ...classNames,
      }}
      components={CALENDAR_COMPONENTS}
      {...props}
    />
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
