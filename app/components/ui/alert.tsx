import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '#app/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive: 'border-destructive/50 bg-destructive/10 text-destructive [&>svg]:text-current',
        // Alert-level counterparts to the Badge variants: the same green and amber
        // pair, and the same rule. Amber carries "needs attention"; red is kept
        // for destructive outcomes only.
        success: 'border-success/50 bg-success/10 text-success [&>svg]:text-current',
        warning: 'border-warning/50 bg-warning/10 text-warning [&>svg]:text-current',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="alert-title" className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
