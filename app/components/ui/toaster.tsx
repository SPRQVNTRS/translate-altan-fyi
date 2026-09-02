import { Toaster as Sonner } from 'sonner';
import { SirenIcon, CheckIcon, AlertTriangleIcon } from 'lucide-react';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ theme, ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        error: <SirenIcon className="text-red-500 w-6 h-6" />,
        success: <CheckIcon className="text-green-500 w-6 h-6" />,
        warning: <AlertTriangleIcon className="text-orange-500 w-6 h-6" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          error: 'border border-red-500/20',
          success: 'border border-green-500/20',
          warning: 'border border-orange-500/20',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-zinc-100 group-[.toast]:text-zinc-900 bg-red-500',
          closeButton: 'group-[.toast]:text-muted-foreground bg-white',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
