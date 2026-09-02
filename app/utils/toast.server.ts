import { createCookieSessionStorage, redirect } from 'react-router';
import { combineHeaders } from '#app/utils/misc';
import { ToastSchema, toastKey, type Toast, type ToastInput } from '#app/utils/toast';

export { ToastSchema, toastKey };
export type { Toast, ToastInput };

export const toastSessionStorage = createCookieSessionStorage({
  cookie: {
    name: 'en_toast',
    sameSite: 'lax',
    path: '/',
    httpOnly: true,
    secrets: [process.env.SESSION_SECRET!],
    secure: process.env.NODE_ENV === 'production',
  },
});

export async function redirectWithToast(url: string, toast: ToastInput, init?: ResponseInit) {
  return redirect(url, {
    ...init,
    headers: combineHeaders(init?.headers, await createToastHeaders(toast)),
  });
}

export async function createToastHeaders(toastInput: ToastInput) {
  const session = await toastSessionStorage.getSession();
  const toast = ToastSchema.parse(toastInput);
  session.flash(toastKey, toast);
  const cookie = await toastSessionStorage.commitSession(session);
  return new Headers({ 'set-cookie': cookie });
}

export async function getToast(request: Request) {
  const session = await toastSessionStorage.getSession(request.headers.get('cookie'));
  const result = ToastSchema.safeParse(session.get(toastKey));
  const toast = result.success ? result.data : null;
  return {
    toast,
    headers:
      toast ?
        new Headers({
          'set-cookie': await toastSessionStorage.destroySession(session),
        })
      : null,
  };
}

export function createActionToastResponse(actionToast: Toast) {
  return {
    description: actionToast.description,
    title: actionToast.title,
    id: actionToast.id,
    type: actionToast.type,
  };
}
