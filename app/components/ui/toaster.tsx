import { Toaster as Sonner } from 'sonner';
import { SirenIcon, CheckIcon, AlertTriangleIcon } from 'lucide-react';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ theme, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        error: <SirenIcon className="text-destructive w-6 h-6" />,
        success: <CheckIcon className="text-success w-6 h-6" />,
        warning: <AlertTriangleIcon className="text-warning w-6 h-6" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          error: 'border border-destructive/20',
          success: 'border border-success/20',
          warning: 'border border-warning/20',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          closeButton: 'group-[.toast]:text-muted-foreground bg-background',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
