/**
 * route-title.ts, the page title a route contributes to the app chrome.
 *
 * WHY A HANDLE AND NOT A PROP
 *   `AppWrapper` renders the one `h1` for every in-app screen, and it is
 *   mounted by the LAYOUT route (`app/routes/_app.tsx`), not by the screen. A
 *   child route therefore has no way to pass a prop upwards. React Router's
 *   answer is the `handle` export: a plain, static object hung off the route
 *   that any component can read back through `useMatches()`.
 *
 * WHY THIS MODULE IS PURE
 *   Nothing here imports React Router, so the resolution rule is a unit under
 *   `node:test` rather than something you can only observe by rendering the
 *   app. The caller passes the matches and a `translate` function; this module
 *   only decides which of them wins.
 *
 * WHY `unknown` IS DECODED RATHER THAN ASSERTED
 *   `handle` and `data` arrive from the router as `unknown`, and they really
 *   are unvalidated: a route can export any object at all, and a match whose
 *   loader never ran carries no data. Both are parsed with a schema, so a route
 *   with a malformed handle degrades to the next candidate instead of throwing
 *   inside the header of every page.
 */
import { z } from 'zod';

/**
 * A route's loader data, decoded only as far as "this is an object".
 *
 * A title callback is handed this rather than a raw `unknown`, so the callback
 * cannot read a field off a value that is not there. The callback still has to
 * parse its own route's shape; this schema only establishes that there is
 * something to parse.
 */
const LoaderDataSchema = z.looseObject({});

/** A route's loader data, after the boundary check above. */
export type RouteLoaderData = z.infer<typeof LoaderDataSchema>;

/** A title derived from a route's own loader data. `null` means "no title from here". */
export type TitleFromData = (data: RouteLoaderData) => string | null;

export interface TitleHandle {
  /** A key into the nav catalog, resolved with `t`. For screens whose name is fixed. */
  titleKey?: string;
  /** Derived from this route's own loader data. Wins over `titleKey`. */
  title?: TitleFromData;
}

/**
 * One entry of `useMatches()`, declared structurally.
 *
 * Written out here rather than imported from React Router so this module stays
 * framework-free and testable with plain objects. `UIMatch` carries both fields
 * as `unknown`, which satisfies this shape.
 */
export interface RouteTitleMatch {
  readonly handle?: unknown;
  readonly data?: unknown;
}

/**
 * The handle shape, parsed rather than asserted.
 *
 * `title` is checked with `instanceof Function` because a schema cannot
 * describe a function's parameters; what matters at this boundary is only that
 * the value is callable, and the declared `TitleFromData` is what the route's
 * `satisfies TitleHandle` already checked at compile time.
 */
const TitleHandleSchema = z.object({
  titleKey: z.string().optional(),
  title: z.custom<TitleFromData>((value) => value instanceof Function).optional(),
});

/** A title is only a title if it says something. */
function firstNonEmpty(candidate: string | null | undefined): string | undefined {
  if (candidate === null || candidate === undefined || candidate === '') return undefined;
  return candidate;
}

/**
 * The title of the deepest match that supplies one, or `undefined`.
 *
 * DEEPEST WINS, because the deepest match is the screen the reader is actually
 * looking at. `/entry/:id` sits inside the `_app` layout, and the layout has no
 * idea which word is on screen. Walking from the end lets a specific screen
 * override a general ancestor without either of them knowing about the other.
 *
 * A match may offer both a derived `title` and a static `titleKey`. The derived
 * one wins, because it was computed from this request's data while the key is a
 * fixed label.
 *
 * @param matches - the `useMatches()` array, root first.
 * @param translate - resolves a catalog key, normally `t` from `useTranslation`.
 * @returns the title to render, or `undefined` when no match supplies one.
 */
export function routeTitle(
  matches: readonly RouteTitleMatch[],
  translate: (key: string) => string,
): string | undefined {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match === undefined) continue;

    const handle = TitleHandleSchema.safeParse(match.handle);
    if (!handle.success) continue;

    if (handle.data.title !== undefined) {
      const data = LoaderDataSchema.safeParse(match.data);
      const derived = data.success ? firstNonEmpty(handle.data.title(data.data)) : undefined;
      if (derived !== undefined) return derived;
    }

    const key = firstNonEmpty(handle.data.titleKey);
    if (key !== undefined) {
      const label = firstNonEmpty(translate(key));
      if (label !== undefined) return label;
    }
  }

  return undefined;
}
