import { useCallback } from 'react';

/**
 * Removes all sessionStorage entries whose key matches `form:{formId}:*`.
 * SSR-safe: no-ops when `window` is not available.
 */
export function clearFormStorage(formId: string): void {
  // SSR-safe: `sessionStorage` only exists in the browser.
  if (!globalThis.sessionStorage) return;

  const prefix = `form:${formId}:`;
  const keysToRemove: string[] = [];

  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    sessionStorage.removeItem(key);
  }
}

/**
 * Returns a stable callback that clears all persisted form data
 * for the given `formId` from sessionStorage.
 */
export function useClearForm(formId: string): () => void {
  return useCallback(() => {
    clearFormStorage(formId);
  }, [formId]);
}
