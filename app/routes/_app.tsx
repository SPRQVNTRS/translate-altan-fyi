import { useEffect } from 'react';
import { Outlet, useRouteLoaderData } from 'react-router';
import AppWrapper from '#app/components/app-wrapper';
import { startSyncScheduler } from '#app/lib/sync/scheduler';
import { clearSyncSession, getSyncSession, setSyncSession } from '#app/lib/sync/sync-session';

/**
 * The layout every in-app screen sits in: sidebar at md and up, drawer plus tab
 * bar below it. The header title comes from the nav catalog, so a screen only
 * passes a title when it needs one the catalog does not carry.
 *
 * THE SYNC TRIGGERS START HERE, and not in `root.tsx`. This is the shell the
 * screens that read the local store sit in, so starting the scheduler here
 * gives it exactly that lifetime. The public and auth layouts read nothing
 * local, and there is no reason for them to hold a store listener or a window
 * event handler.
 *
 * IT COSTS AN ANONYMOUS VISITOR NOTHING. `startSyncScheduler` returns a no-op
 * during SSR, and checks for a sync session at every trigger, so a visitor who
 * never signs up subscribes to nothing and issues no request. That is the
 * product rule this app is built on: an account is an opt-in, and nothing on
 * the search, lists, history or entry path may require one.
 *
 * The effect has an EMPTY dependency list on purpose. Anything that changes per
 * navigation would tear the listeners down and rebuild them on every route
 * change, which turns a debounced burst of edits into a queue of half-settled
 * ones.
 *
 * THE SESSION IS INSTALLED FROM THE ROOT LOADER, and this is the line that
 * makes sync run at all. Before M191 a session existed only for as long as the
 * in-memory data key did, so a reload lost it and the device sat there holding
 * a full local store and syncing nothing. The credential is a cookie now, so
 * the server answers `userId` on every document and this effect hands it
 * straight to the engine. Signing out clears it, and so does a `401`.
 *
 * IT RUNS ON EVERY CHANGE OF THAT ID, unlike the scheduler above: the id is
 * exactly what changes when somebody signs in or out, and `setSyncSession`
 * notifies the scheduler's own listener, so a fresh sign-in pulls immediately
 * instead of waiting for the reader to switch tabs and come back.
 */
export default function AppLayout() {
  const rootData = useRouteLoaderData<{ userId: number | null }>('root');
  const userId = rootData?.userId ?? null;

  useEffect(() => startSyncScheduler(), []);

  useEffect(() => {
    if (userId === null) {
      clearSyncSession();
      return;
    }
    // Re-installing the same session would re-notify the scheduler and start a
    // redundant cycle on every root revalidation, and every client action
    // revalidates root (see `root.tsx`'s clientLoader).
    if (getSyncSession()?.userId === userId) return;
    setSyncSession({ userId });
  }, [userId]);

  return (
    <AppWrapper>
      <Outlet />
    </AppWrapper>
  );
}
