# translate.altan.fyi Design Language

This design language adapts openplate (`openplate/DESIGN.md`), a sibling
product. Both products share core traits: a teal-tinted neutral scale on every
surface, a single teal brand accent, and a display serif font for the chrome.
The chrome means the surrounding browser frame and UI shell. The visual feel is
a quiet study tool: clean, text-forward, and unhurried. It is neither a playful
consumer app nor a dense dashboard.

Tokens, shadcn primitives, and the outer shell come directly from openplate.
This shared base keeps both products related and saves work on the component
library. This document defines the interface rules for THIS product. Use these
recipes for all new UI. Do not invent new patterns.

---

## 0. Two rules that override everything

These operator rules are enforced by a unit test
(`tests/unit/design-rules.test.ts`). Code review forgets, but tests run on every
build.

1. **Never use a thick left border to accentuate an element.** Do not use
   `border-l-4`, `border-l-[3px]`, `border-left: 4px`, or `border-left: 3px`.
   Lift a block with a background wash, a full hairline border, or an icon.
2. **Never use em dashes in copy, use a comma instead.** This rule applies to
   user-facing strings, code comments, and CLI output.

---

## 1. Principles

1. **Neutrals carry the chrome, teal carries the brand.** Most elements use
   neutral colors. Reserve teal for elements that need user focus: the primary
   button, the active nav item, the focus ring, links, and the single hero card
   on a screen.
2. **The word is the subject.** Treat a search result as writing, not as a data
   row. Format text with care: set a readable line width, add generous line
   spacing, and maintain clear contrast between the translation, the
   explanation, and the examples.
3. **Feedback is mandatory.** Every asynchronous action shows its state. A
   pending button displays a spinner and a dynamic label. A data update triggers
   a toast message. A destructive action opens a confirmation dialog.
   `window.confirm` is banned. Never leave the interface looking frozen.
4. **Dark mode is a first-class parallel palette**, not an inversion. Every
   recipe below includes an explicit dark variant. Ship both palettes with every
   new component.
5. **Soft but dense.** Combine generous corner curves, subtle shadows, and
   compact data density.

---

## 2. Color tokens

Semantic tokens live in `app/app.css` as HSL triplets, following shadcn
convention. Every surface and hairline border uses the brand hue of 192 degrees
at low saturation. The chrome, the page, and the cards form a single teal-tinted
system instead of a teal accent placed on cold grey.

| Token                  | Light                   | Dark                      | Usage                         |
| ---------------------- | ----------------------- | ------------------------- | ----------------------------- |
| `--background`         | `192 34% 96%` pale teal | `192 24% 4.5%` teal-black | page                          |
| `--foreground`         | `200 18% 8%`            | `180 12% 97%`             | text                          |
| `--card`               | white                   | `192 20% 8%`              | card surfaces                 |
| `--muted` / `--accent` | `192 26% 93%`           | `192 16% 15%`             | hover surfaces, subdued fills |
| `--muted-foreground`   | `197 14% 38%`           | `190 12% 68%`             | secondary text                |
| `--border` / `--input` | `192 22% 85%`           | `192 16% 17%`             | hairlines                     |
| `--primary`            | `179 92% 25%`           | `172 70% 52%`             | CTAs, links, active nav       |
| `--primary-foreground` | white                   | `187 90% 8%`              | text on primary               |
| `--destructive`        | `0 72% 45%`             | `0 70% 45%`               | delete, disconnect            |
| `--ring`               | same as `--primary`     | same as `--primary`       | focus rings                   |

`--card` stays pure white in light mode so cards stand out from the tinted page.
`--foreground` maintains a contrast ratio above 15:1 against the card and page.
`--muted-foreground` maintains about 7.6:1 against white and 7:1 in dark mode.

The macro, adherence, and carb-status tokens from openplate were omitted. Those
tokens describe food, which this product does not handle. Do not add them back
speculatively. Add tokens only when a concrete screen needs them.

**Brand discipline.** Neutrals use a teal tint across the whole app. Limit
saturated teal surfaces strictly. Only three utilities in `app.css` apply one.
Each uses an `hsl(var(--primary) / ...)` gradient, never a raw literal value:

- `.surface-brand` styles the ONE hero card on a screen. Use it once per screen,
  never twice.
- `.surface-brand-soft` styles empty-state panels, paired with `border-dashed`.
- `.brand-glow` styles backdrops behind hero elements only.

Other components use `bg-card`. Standard cards, list rows, and inputs never take
a brand fill.

**One hero per screen, named:** The Search view uses the search hero card. The
Lists view uses its empty state panel, and once lists exist, it uses no hero at
all. History also uses no hero. Placing a second `.surface-brand` on any screen
is a bug.

**Where the brand shows up outside a hero**, use only these token-based
treatments:

| Surface                          | Treatment                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Section labels above a block      | `text-[11px] font-semibold uppercase tracking-[0.11em] text-primary`, optional hairline at `bg-primary/20` |
| Card titles, app-wide             | `font-display` (Fraunces) via the `CardTitle` primitive, never on a live figure       |
| Interactive row or chip hover     | `hover:border-primary/40 hover:bg-primary/5`                                          |
| Active bottom-nav tab             | `bg-primary/5` plus an `after:` top rule at `bg-primary`                               |
| Active sidebar row                | the `SidebarMenuButton` `isActive` state, which already carries the brand              |

---

## 3. Surfaces

Build all UI from these four v1 surfaces. To introduce a fifth surface, define
it here first.

**Search hero card.** This is the only `.surface-brand` element on the Search
screen. Style it with `rounded-2xl`, a large `Input`, a primary `Button`, and
one muted line explaining the search. It sits at the top of the page as the main
app entry point. Because of this role, it receives the brand wash while all
other elements on the screen stay plain.

**Entry card** (a word or phrase and its translation). Use `rounded-lg border
bg-card shadow-sm` and `hover:shadow-md hover:border-primary/40 transition-all
duration-200`. Arrange child elements in this order: the source term in
`font-display` using `CardTitle`, the translation at `text-base`, the
explanation at `text-sm text-muted-foreground`, and the examples. Place sense
chips directly below the title. Render them as a row of `rounded-full
bg-primary/10 px-2 py-0.5 text-xs text-primary` pills, one per word meaning. A
chip acts as both a filter and a label, so always explain the sense elsewhere on
the card too.

**List row.** This surface represents a saved word inside a list. Apply `flex
items-center gap-3 rounded-lg px-3 py-2`. Render the term with `text-sm
font-medium` and the translation with `text-sm text-muted-foreground truncate`.
Apply the row hover tokens from the table above. Separate rows using their hover
states and hairline borders. Never use a left border accent.

**History row.** Use the same base structure as a list row. Add a right-aligned
relative timestamp with `text-xs text-muted-foreground tabular-nums`. History
lists are chronological and repeat often. Keep them visual-light: omit the card
container and shadow, and render simple rows on the page.

---

## 4. Typography

- **Body font: Inter Variable (`font-sans`) on `<body>`.** Use Victor Mono
  Variable (`font-mono`) only for technical strings, phonetic transcriptions,
  and code blocks. Inter serves as the voice for UI text and prose.
- **Display serif: Fraunces (`font-display`)**, self-hosted in `public/fonts/`.
  Use Fraunces for the wordmark, page titles, and card titles. This adds brand
  character to views past the hero card. **Never on a live figure.** Fraunces
  does not include tabular figures, so numbers shift width when values change.
  Always render dynamic numbers in `font-sans` with `tabular-nums`. Tabular
  figures have equal widths so columns align.
- Fonts are **self-hosted**: Import Inter and Victor Mono using
  `@fontsource-variable/*` packages in `root.tsx`. Declare Fraunces using the
  `@font-face` block in `app/app.css`. Never load fonts from Google Fonts or an
  external CDN. This protects user privacy.
- Scale (standard Tailwind utilities):
  - Page title: `text-2xl font-semibold tracking-tight`
  - Hero: `text-4xl font-bold tracking-tight sm:text-5xl`
  - Card title: `text-lg font-semibold`
  - Body: `text-sm` by default, `text-base` for translations or example
    sentences
  - Meta, labels, badges: `text-xs`; muted meta: `text-xs text-muted-foreground`
- Set emphasis weights to `font-semibold`.
- **Foreign-language text carries a `lang` attribute.** Screen readers need this
  attribute to load the right voice for foreign text, such as a German example
  sentence. This accessibility feature is required.

---

## 5. Shape, elevation, spacing

- Corner radii: Use `rounded-md` for buttons, inputs, and thumbnails. Use
  `rounded-lg` for cards and dialogs as the default curve. Use `rounded-xl` for
  feature tiles and `rounded-2xl` for the search hero. Use `rounded-full` for
  pills, chips, and status dots. Keep `--radius: 0.5rem`.
- Shadows: Use `shadow-sm` at rest, `hover:shadow-md` on interactive cards, and
  `shadow-lg` on overlays. Never apply heavier shadows to elements at rest.
- Interactive-card hover recipe: Apply `transition-all duration-200
  hover:shadow-md hover:border-primary/40`. Omit `dark:` prefixes because
  `primary` colors adapt to the active theme automatically.
- Page container: Use `mx-auto max-w-3xl px-4 sm:px-6`. Keep the single-column
  layout narrow. Full-width translation text is hard to read.
- Vertical rhythm: Use `space-y-6` between page sections, `space-y-4` inside
  cards, and `gap-2` between form labels and inputs.

---

## 6. The shell

The wrapper in `app/components/app-wrapper.tsx` renders both responsive layouts:

- **Mobile:** A fixed bottom tab bar (`app/components/bottom-nav.tsx`) links to
  Search, Lists, and History. A left-side slide-out drawer holds the full site
  map, including Settings and Account.
- **Desktop (`md` and up):** A collapsible sidebar
  (`app/components/app-sidebar.tsx`) displays the full site map, placing
  configuration options below a divider rule.

All three navigation views read from ONE catalog exported by `app-sidebar.tsx`.
Update labels and paths in that single file. This shared source prevents routing
mismatches between menus.

The bottom bar provides three equal, flat tabs. The raised center button from
openplate was removed because this app has no single primary action that users
tap repeatedly.

---

## 7. Motion and feedback (non-negotiables)

- **Pending buttons:** Every active submit button disables itself and renders
  `Loader2` with `animate-spin` and status copy ("Searching...", "Saving...").
  Never swap text without an indicator.
- **Long operations** (such as language model calls for explanations): Display
  phased status copy based on elapsed time. Avoid multi-second delays without
  feedback.
- **Toasts** (sonner, mounted once in `root.tsx`): Show a success notification
  for every data change. Support theme changes dynamically without hardcoding
  `theme="light"`. Position toasts clear of the bottom tab bar.
- **Destructive actions:** Require an `AlertDialog` confirmation with a
  destructive button style and a loading spinner.
- **Radix enter and exit:** Apply the default `tw-animate-css` state animations.
- **View transitions:** Wrap internal links in `app/components/link.tsx`. This
  file defaults react-router's `viewTransition` setting to true, creating a
  200ms document cross-fade. Avoid custom shared-element transitions until views
  share stable elements across routes.
- **Reduced motion** is handled by media queries in `app.css`. These queries
  disable view transitions and toast animations. Because the app lacks a manual
  motion setting, the system media query is the sole control.
- **The waiting vocabulary** uses two classes from `app.css`: `.pulse-soft` and
  `.loading-dots`. Use them only when an operation is pending. Never apply them
  as decoration on static content.

---

## 8. Dark mode

Dark mode uses class-based styling via `.dark` on `<html>`. A custom toggle in
localStorage supports light, dark, and system options. An inline script in
`root.tsx` injects the class before the browser paints to prevent theme
flashing. Provide both light and dark styles for every new component. Overlays
and toast notifications must read the active theme instead of hardcoding one.

---

## 9. Voice

Use one consistent voice: **warm, plainspoken, non-shaming, and literally
true.** Apply these priority rules:

1. **Never imply the user failed.** The app exists because users need help with
   unfamiliar words. Focus copy on the WORD or the DATA, not the user. Avoid
   streak guilt and warnings like "you haven't studied since...".
2. **Never claim more than is true.** State clearly when a dictionary lacks an
   entry. Disclose when translations come from a model instead of a curated
   dictionary. Write honest messages with warmth, not false comfort.
3. **Sentence case, ordinary words.** Use sentence case for button text. Avoid
   technical terms like "instance", "invalid", or "payload" in user-facing
   views. Use "Log in" everywhere instead of "Login" or other variations.
4. **Confirmations end in a period and state the outcome.** Write "Saved to your
   list." or "List deleted."
5. **Empty is not an error.** Write "Your saved words will collect here." Never
   write "No data", "Nothing found", or "No results".
6. **"Coming soon" is a dead end.** Explain what is missing, provide current
   workarounds, and estimate how long the alternative takes.
7. **One phrasing per idea.** Do not duplicate text across different screens.
8. **All copy and all translations go through `pnpm -C djinn wordsmith`.** Never
   write or translate interface strings by hand. The tool blocks changes that
   drop keys or translate code placeholders, preventing human errors.

---

## 10. Don'ts

- No em dashes. See section 0.
- No thick left border accents. See section 0.
- No new accent colors. Use brand washes sparingly via the three `app.css`
  utilities in the locations listed in section 2. Never hardcode color values in
  components.
- No `text-teal-*`, `bg-emerald-*`, or `bg-zinc-*` utility classes in app code.
  Reference brand and neutral values through design tokens. Place raw color
  values in `app/app.css` only.
- No `window.confirm` and no `window.alert`.
- No unlabeled spinners in page content. Attach spinners directly to the
  triggering element.
- No Google Fonts and no CDN assets. Self-host all resources.
- No custom card or badge utility combinations when an existing recipe applies.
- No second `.surface-brand` on a screen that already uses one.
