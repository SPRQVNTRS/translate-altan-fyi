import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '#app/components/ui/button';

/**
 * Copies one value to the clipboard and says so.
 *
 * The confirmation is a separate prop rather than a derived string, because
 * only the handle has a "copied" sentence in the catalog. A button without one
 * still confirms, through the icon, instead of borrowing a sentence written
 * about something else.
 *
 * The clipboard write can be refused (a denied permission, an insecure origin,
 * an older browser), so the failure is swallowed and the label simply does not
 * change. The value is on screen either way, which is what the step is really
 * for: this button is a convenience over reading it, never the only way to get
 * it.
 */
export function CopyButton({ value, label, copiedLabel }: { value: string; label: string; copiedLabel?: string }) {
  const [hasCopied, setHasCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setHasCopied(true);
    } catch {
      setHasCopied(false);
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
      {hasCopied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
      {hasCopied && copiedLabel !== undefined ? copiedLabel : label}
    </Button>
  );
}
