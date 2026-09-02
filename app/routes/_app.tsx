import { useEffect } from 'react';
import { Outlet } from 'react-router';
import AppWrapper from '#app/components/app-wrapper';
import { startSyncScheduler } from '#app/lib/sync/scheduler';

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
 */
export default function AppLayout() {
  useEffect(() => startSyncScheduler(), []);

  return (
    <AppWrapper>
      <Outlet />
    </AppWrapper>
  );
}
