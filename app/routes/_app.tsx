import { Outlet } from 'react-router';
import AppWrapper from '#app/components/app-wrapper';

/**
 * The layout every in-app screen sits in: sidebar at md and up, drawer plus tab
 * bar below it. The header title comes from the nav catalog, so a screen only
 * passes a title when it needs one the catalog does not carry.
 */
export default function AppLayout() {
  return (
    <AppWrapper>
      <Outlet />
    </AppWrapper>
  );
}
