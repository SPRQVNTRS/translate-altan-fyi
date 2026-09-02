import type { Dispatch, SetStateAction } from 'react';
import useSessionStorageState from 'use-session-storage-state';

/**
 * Hook to persist a form field value in sessionStorage.
 * SSR-safe and API-compatible with useState for drop-in replacement.
 *
 * Key format: `form:{formId}:{field}`
 *
 * @param formId - Unique identifier for the form
 * @param field - Field name within the form
 * @param defaultValue - Initial value when no stored value exists
 * @returns Tuple of [value, setValue] matching the useState API
 */
export function useFormField<T>(
  formId: string,
  field: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const key = `form:${formId}:${field}`;
  const [value, setValue] = useSessionStorageState<T>(key, { defaultValue });
  return [value, setValue];
}
