import type { ReactElement } from 'react';
import { APP_NAME } from '#app/lib/app-name';

/**
 * The Kenning brand mark: three rounded cards, stacked and offset.
 *
 * THE GEOMETRY IS MEASURED, NOT DRAWN HERE. The three rectangles, their radii
 * and their stroke are the same numbers `public/icons/icon.svg` ships, so the
 * favicon, the installed app icon and this component are one mark. Do not
 * nudge a coordinate on its own: change the drawing, then both files together.
 *
 * THE TWO FILLS ARE RAW COLOUR VALUES ON PURPOSE. DESIGN.md section 10 says
 * "Never hardcode color values in components", and this is the one exception:
 * a brand mark is artwork rather than themed UI, and a token that repainted
 * with the palette would repaint the logo with it. The palette was read off
 * this mark, not the other way round (DESIGN.md, opening section). Do not
 * "fix" these two hex values into tokens.
 *
 * THE STROKE IS THE GAP BETWEEN THE CARDS, not an outline: it is what makes the
 * overlapping cards read as three separate ones. It is `var(--mark-gap)` so a
 * caller sitting on a dark surface can set that property and have the gap match
 * the fill behind it. Nothing overrides it today, and the fallback is the same
 * near-white the icon file uses.
 */
export function KenningMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 512 512" aria-label={APP_NAME} className={className}>
      {/* THE NAME IS CARRIED TWICE, AND `role="img"` IS NOT USED.
          `jsx-a11y/prefer-tag-over-role` rejects `role="img"` on any element,
          and the lint gate is not negotiable, so the accessible name comes from
          `aria-label` with a `<title>` behind it. That pair is the recipe that
          works without the role: a screen reader that ignores `aria-label` on a
          bare `<svg>` still reads the title, so the mark is never announced as
          an unnamed graphic. */}
      <title>{APP_NAME}</title>
      <rect
        x="70"
        y="64"
        width="285"
        height="179"
        rx="36"
        ry="36"
        fill="#F9A918"
        stroke="var(--mark-gap, #FFFEFD)"
        strokeWidth="16"
        strokeLinejoin="round"
      />
      <rect
        x="160"
        y="156"
        width="285"
        height="179"
        rx="36"
        ry="36"
        fill="#F9A918"
        stroke="var(--mark-gap, #FFFEFD)"
        strokeWidth="16"
        strokeLinejoin="round"
      />
      <rect
        x="70"
        y="262"
        width="285"
        height="179"
        rx="36"
        ry="36"
        fill="#F85B46"
        stroke="var(--mark-gap, #FFFEFD)"
        strokeWidth="16"
        strokeLinejoin="round"
      />
    </svg>
  );
}
