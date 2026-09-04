# translate.altan.fyi Design Language

This product has its own look. A blue-tinted neutral scale on every surface, a
single open-blue brand accent, a display grotesque for the chrome, and
monospaced headwords. The chrome means the surrounding browser frame and UI
shell. The visual feel is a quiet study tool: clean, text-forward, and
unhurried. It is neither a playful consumer app nor a dense dashboard.

The colour tokens and the display face were teal and a display serif until
M186, both copied from openplate (`openplate/DESIGN.md`), a sibling product.
They are neither of those things now: the palette is the operator's own choice,
"Open blue", and the display face is Bricolage Grotesque. Do not read a token
value or a font name back out of openplate.

What DOES still come from openplate is the component library: the shadcn
primitives under `app/components/ui/` and the shape of the outer shell. That
shared base saves work and keeps the two products structurally familiar, and it
carries no colour and no face of its own, so the two can look nothing alike and
still share it. This document defines the interface rules for THIS product. Use
these recipes for all new UI. Do not invent new patterns.

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

1. **Neutrals carry the chrome, blue carries the brand.** Most elements use
   neutral colors. Reserve the brand blue for elements that need user focus: the
   primary button, the active nav item, the focus ring, links, and the single
   hero card on a screen.
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
convention. Every surface and hairline border uses the brand hue of 208 degrees
at low saturation. The chrome, the page, and the cards form a single blue-tinted
system instead of a blue accent placed on cold grey. The values below are the
ones in `app/app.css`. Change them in one place and copy them here in the same
edit: a token table that drifts from the stylesheet is worse than no table.

| Token                  | Light                   | Dark                      | Usage                         |
| ---------------------- | ----------------------- | ------------------------- | ----------------------------- |
| `--background`         | `208 46% 95%` pale blue | `208 34% 5%` blue-black   | page                          |
| `--foreground`         | `209 26% 9%`            | `200 16% 97%`             | text                          |
| `--card`               | white                   | `208 28% 8.5%`            | card surfaces                 |
| `--muted`              | `208 38% 91%`           | `208 20% 15%`             | hover surfaces, subdued fills |
| `--accent`             | `208 42% 88%`           | `208 22% 17%`             | hover surfaces, subdued fills |
| `--muted-foreground`   | `207 18% 37%`           | `203 14% 69%`             | secondary text                |
| `--border` / `--input` | `208 30% 82%`           | `208 20% 17%`             | hairlines                     |
| `--primary`            | `206 86% 34%`           | `199 90% 58%`             | CTAs, links, active nav       |
| `--primary-foreground` | white                   | `205 82% 8%`              | text on primary               |
| `--destructive`        | `0 72% 45%`             | `0 70% 45%`               | delete, disconnect            |
| `--ring`               | same as `--primary`     | same as `--primary`       | focus rings                   |

`--card` stays pure white in light mode so cards stand out from the tinted page.
`--foreground` maintains a contrast ratio above 15:1 against the card and page.
`--muted-foreground` maintains about 7.5:1 against white and 7:1 in dark mode.
The brand is darker in light mode and brighter in dark mode, rather than one
value in both: a 34% lightness blue on a near-black page reads as a bruise.

The macro, adherence, and carb-status tokens from openplate were omitted. Those
tokens describe food, which this product does not handle. Do not add them back
speculatively. Add tokens only when a concrete screen needs them.

**Brand discipline.** Neutrals use a blue tint across the whole app. Limit
saturated blue surfaces strictly. Only three utilities in `app.css` apply one.
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
| Card titles, app-wide             | `font-display` (Bricolage Grotesque) via the `CardTitle` primitive, never on a live figure |
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
`font-mono text-lg font-semibold tracking-tight`, the translation at `text-base`
and also in `font-mono`, the explanation at `text-sm text-muted-foreground` in
the sans face, and the examples. The term and its translation are the only
monospaced text on the card. See section 4. Place sense
chips directly below the title. Render them as a row of `rounded-full
bg-primary/10 px-2 py-0.5 text-xs text-primary` pills, one per word meaning. A
chip acts as both a filter and a label, so always explain the sense elsewhere on
the card too.

**List row.** This surface represents a saved word inside a list. Apply `flex
items-center gap-3 rounded-lg px-3 py-2`. Render the term with `text-sm
font-medium` and the translation with `text-sm text-muted-foreground truncate`.
Both stay in `font-sans`: the monospaced treatment in section 4 is for the word
being looked at, not for every row that names one.
Apply the row hover tokens from the table above. Separate rows using their hover
states and hairline borders. Never use a left border accent.

**History row.** Use the same base structure as a list row. Add a right-aligned
relative timestamp with `text-xs text-muted-foreground tabular-nums`. History
lists are chronological and repeat often. Keep them visual-light: omit the card
container and shadow, and render simple rows on the page.

---

## 4. Typography

- **Body font: Inter Variable (`font-sans`) on `<body>`.** Inter serves as the
  voice for UI text and prose.
- **`font-mono` for technical strings**: handles, device and model ids,
  workflow ids, phonetic transcriptions, and code blocks. Victor Mono Variable
  is the face.
- **`font-mono` for the word under examination, and for its translation.** This
  is a separate rule from the technical-string one above, and it is scoped
  narrowly. It applies to the term and its translation in: the Entry card
  (`search-results.tsx`), `SearchResults`, `PhraseResults`, `DidYouMean`'s
  suggestion, and the translation chips in the generated-notes panel, which the
  entry page and the search screen's output pane both render. It does NOT apply
  to list rows or history rows, which stay in `font-sans`: a saved row is a
  place in a collection, and the mono face is reserved for the word being looked
  at right now. It also does not apply to a gloss, an explanation, a usage note
  or an example sentence, which are prose ABOUT a word rather than the word.
- **Display face: Bricolage Grotesque (`font-display`)**, self-hosted in
  `public/fonts/`. Use it for the wordmark, page titles, and card titles. This
  adds brand character to views past the hero card. It is a grotesque, not a
  serif: the display serif this product used to carry is the face openplate
  carries in the same role, and a display sans over monospaced headwords reads
  as a tool rather than as a storybook. **Never on a live figure.** The shipped
  subset offers no tabular figures, so numbers shift width when values change.
  Always render dynamic numbers in `font-sans` with `tabular-nums`. Tabular
  figures have equal widths so columns align.
- Fonts are **self-hosted**: Import Inter and Victor Mono using
  `@fontsource-variable/*` packages in `root.tsx`. Declare Bricolage Grotesque
  using the `@font-face` block in `app/app.css`, over the single woff2 file in
  `public/fonts/`. Never load fonts from Google Fonts or an external CDN. This
  protects user privacy.
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

The wrapper in `app/components/app-wrapper.tsx` renders both responsive layouts.
Its header carries one account slot on every screen: a "Sign in" link to
`/sign-in` for an anonymous visitor, and the reader's sign-in name, linking to
`/account`, for a signed-in one. An account is required for every search since
M184, so the shell shows the door rather than hiding it. The two doors are
`/sign-up` and `/sign-in`; sync is a consequence of holding an account and is
never presented as something a reader sets up.

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
- No raw Tailwind palette utilities in app code, such as `text-sky-*`,
  `bg-blue-*`, or `bg-zinc-*`. Reference brand and neutral values through design
  tokens. Place raw color values in `app/app.css` only.
- No `window.confirm` and no `window.alert`.
- No unlabeled spinners in page content. Attach spinners directly to the
  triggering element.
- No Google Fonts and no CDN assets. Self-host all resources.
- No custom card or badge utility combinations when an existing recipe applies.
- No second `.surface-brand` on a screen that already uses one.
