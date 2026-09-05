import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#app/components/ui/alert-dialog';
import { Button } from '#app/components/ui/button';
import { Loader2 } from 'lucide-react';

interface ConfirmActionProps {
  /** The trigger element (usually a button) */
  trigger: React.ReactNode;
  /** Title shown in the confirmation dialog */
  title: string;
  /** Description shown in the confirmation dialog */
  description: string;
  /** Hidden form fields to submit */
  formData?: Record<string, string | number>;
  /** Text for the confirm button (defaults to "Continue") */
  confirmText?: string;
  /**
   * Text for the confirm button while the action is in flight.
   *
   * A pending button must say what it is busy doing, and only the caller knows
   * that. Falls back to `confirmText`, so a caller that has no progressive
   * label still reads as it did before.
   */
  confirmPendingText?: string;
  /** Text for the cancel button (defaults to "Cancel") */
  cancelText?: string;
  /** Variant for the confirm button */
  confirmVariant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  /** Callback when action completes successfully */
  onSuccess?: () => void;
  /** Callback when action fails */
  onError?: (error: string) => void;
}

/** Stable identity for the default, since an inline `{}` is a new object every render. */
const EMPTY_FORM_DATA: Record<string, string | number> = {};

export function ConfirmAction({
  trigger,
  title,
  description,
  formData = EMPTY_FORM_DATA,
  confirmText = 'Continue',
  confirmPendingText,
  cancelText = 'Cancel',
  confirmVariant = 'default',
  onSuccess,
  onError,
}: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<{ success: boolean; error?: string }>();
  const isSubmitting = fetcher.state !== 'idle';

  // Handle the fetcher's answer, AFTER the commit rather than during the
  // render. `onSuccess` is where callers raise their confirmation toast, and a
  // toast raised mid-render updates the Toaster while another component is
  // rendering, which React warns about.
  //
  // Each answer is handled once. The callbacks are inline closures at every
  // call site, so this re-runs on every parent render, and a confirmation the
  // reader has already seen must not be repeated.
  const handled = useRef<object | null>(null);
  useEffect(() => {
    const data = fetcher.data;
    if (!data || fetcher.state !== 'idle' || handled.current === data) return;
    handled.current = data;
    if (data.success) {
      setOpen(false);
      onSuccess?.();
      return;
    }
    if (data.error) onError?.(data.error);
  }, [fetcher.data, fetcher.state, onSuccess, onError]);

  const handleConfirm = () => {
    const form = new FormData();
    Object.entries(formData).forEach(([key, value]) => {
      form.append(key, String(value));
    });
    fetcher.submit(form, { method: 'post' });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {fetcher.data?.error && (
          <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
            {fetcher.data.error}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>{cancelText}</AlertDialogCancel>
          <Button variant={confirmVariant} onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSubmitting ? (confirmPendingText ?? confirmText) : confirmText}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
