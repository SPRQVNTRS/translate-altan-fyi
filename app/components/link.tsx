import * as React from 'react';
import { Link as RouterLink, NavLink as RouterNavLink, type LinkProps, type NavLinkProps } from 'react-router';

/**
 * The app's `Link` / `NavLink`.
 *
 * Thin re-exports of react-router's own components with `viewTransition`
 * defaulted to `true`, so every internal navigation runs inside
 * `document.startViewTransition()` and the page cross-fades instead of
 * snapping. The fade itself is 200ms of pure opacity on the `root` snapshot
 * (`::view-transition-old(root)` / `-new(root)` in `app/app.css`). It is
 * deliberately shorter and quieter than a marketing-site transition, because
 * this is a tool people open several times a day.
 *
 * Three things this intentionally does NOT do:
 *
 * - **No shared-element morphs.** Nothing in the app has a stable visual
 *   counterpart across two routes yet, and a half-applied morph is worse than
 *   none. When one arrives it gets its own `view-transition-name` plus a
 *   `::view-transition-group()` rule, applied per-navigation via
 *   `useViewTransitionState` so two on-screen copies of a name can't collide.
 * - **No feature detection.** Browsers without the View Transitions API make
 *   react-router's `viewTransition` a no-op; there is nothing to polyfill and
 *   nothing to branch on.
 * - **No motion toggle.** The app has no in-app motion setting, so the OS-level
 *   `prefers-reduced-motion: reduce` media query is the only switch. The
 *   `app.css` block kills every `::view-transition-*` animation under it.
 *
 * Opt an individual link out with `viewTransition={false}`. External
 * destinations keep using a plain `<a>`; this module is for in-app routes only.
 */
export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { viewTransition = true, ...props },
  ref,
) {
  return <RouterLink ref={ref} viewTransition={viewTransition} {...props} />;
});

export const NavLink = React.forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(
  { viewTransition = true, ...props },
  ref,
) {
  return <RouterNavLink ref={ref} viewTransition={viewTransition} {...props} />;
});
