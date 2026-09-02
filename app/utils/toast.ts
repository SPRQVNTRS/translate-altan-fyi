/**
 * The toast contract, shared by the server (which writes toasts into the flash
 * session) and the client (which decodes a fetcher payload back into one).
 *
 * Lives outside `toast.server.ts` so importing the schema from a component does
 * not pull the session-storage module into the client bundle.
 */
import { createId as cuid } from '@paralleldrive/cuid2';
import { z } from 'zod';

export const toastKey = 'toast';

export const ToastSchema = z.object({
  id: z.string().default(() => cuid()),
  title: z.string().optional(),
  description: z.string(),
  type: z.enum(['message', 'success', 'error', 'warning']).default('message'),
});

export type Toast = z.infer<typeof ToastSchema>;
export type ToastInput = z.input<typeof ToastSchema>;
