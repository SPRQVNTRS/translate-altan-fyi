import { ToastSchema, type Toast } from '#app/utils/toast';
import { z } from 'zod';

/**
 * A fetcher payload that really is a toast. Unlike `ToastSchema`, `id` and
 * `type` are required — a fetcher returning some other object must not be
 * mistaken for a toast just because the schema would default those fields in.
 */
const fetcherToastSchema = ToastSchema.extend({
  id: z.string(),
  type: z.enum(['message', 'success', 'error', 'warning']),
});
import { useEffect, useRef } from 'react';
import { toast as showToast } from 'sonner';
import { useFetcher } from 'react-router';

export function useToast(toast?: Toast | null) {
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (toast && !shown.current.has(toast.id)) {
      shown.current.add(toast.id);
      setTimeout(() => {
        showToast[toast.type](toast.title, {
          id: toast.id,
          description: toast.description,
        });
      }, 0);
    }
  }, [toast]);
}

export function useFetcherWithToast<T>() {
  const fetcher = useFetcher<T>();

  useEffect(() => {
    // A fetcher's payload is whatever its action returned — decode it against
    // the toast contract instead of probing its shape.
    const parsed = fetcherToastSchema.safeParse(fetcher.data);
    if (parsed.success) {
      const { type, title, description, id } = parsed.data;

      switch (type) {
        case 'error':
          showToast.error(title, { id, description });
          break;
        case 'warning':
          showToast.warning(title, { id, description });
          break;
        case 'success':
          showToast.success(title, { id, description });
          break;
        case 'message':
        default:
          showToast.message(title, { id, description });
          break;
      }
    }
  }, [fetcher.data]);

  return fetcher;
}
