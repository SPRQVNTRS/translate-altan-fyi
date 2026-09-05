# kenning.altan.fyi Design Language

This product has its own look. A warm-tinted neutral scale on every surface, a
deep ochre brand accent, a display grotesque for the chrome, and monospaced
headwords. The chrome means the surrounding browser frame and UI shell. The
visual feel is a quiet study tool: clean, text-forward, and unhurried. It is
neither a playful consumer app nor a dense dashboard.

The palette has moved twice, and the reason matters more than the values. It
was teal and a display serif until M186, both copied from openplate
(`openplate/DESIGN.md`), a sibling product. It became "Open blue" in M186, the
operator's own choice. It became warm on 2026-09-05, and this time the palette
was NOT chosen in the abstract: it was read off the Kenning brand mark, a stack
of rounded cards drawn in amber and coral. The mark came first and the tokens
follow it, which is why the corner radius moved in the same edit. Do not read a
token value or a font name back out of openplate, and do not repaint a token
without asking what it does to the mark.

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

1. **Neutrals carry the chrome, ochre carries the brand.** Most elements use
   neutral colors. Reserve the brand ochre for elements that need user focus: the
   primary button, the active nav item, the focus ring, links, and the single
   hero card on a screen where one exists. Not every screen has one: the
   translator surface in section 3 deliberately has no brand wash at all.
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
6. **A control that names the data must name the data that was USED.** Where the
   server resolves, repairs or detects a value, the control shows the resolved
   value, never the one the reader asked for. The language bar rendered the
   requested target `Deutsch` over results the server had already redirected
   into English, and every result link on the same page said `to=en`. Nothing on
   screen looked broken, which is what makes this class of bug expensive. If a
   label and a query can be taken from two different values, they eventually
   will be, so take both from one.

---

## 2. Color tokens

Semantic tokens live in `app/app.css` as HSL triplets, following shadcn
convention. Every surface and hairline border carries the brand's own warm hue
at low saturation. The chrome, the page, and the cards form a single warm
system instead of a warm accent placed on cold grey. The values below are the
ones in `app/app.css`. Change them in one place and copy them here in the same
edit: a token table that drifts from the stylesheet is worse than no table.

| Token                  | Light           | Dark            | Usage                         |
| ---------------------- | --------------- | --------------- | ----------------------------- |
| `--background`         | `36 44% 96%` cream | `30 18% 5%` warm black | page                   |
| `--foreground`         | `30 20% 10%`    | `38 14% 97%`    | text                          |
| `--card`               | white           | `30 15% 8.5%`   | card surfaces                 |
| `--muted`              | `38 36% 91%`    | `30 12% 15%`    | hover surfaces, subdued fills |
| `--accent`             | `38 40% 88%`    | `30 14% 17%`    | hover surfaces, subdued fills |
| `--muted-foreground`   | `32 12% 33%`    | `36 10% 70%`    | secondary text                |
| `--border` / `--input` | `36 26% 82%`    | `30 12% 17%`    | hairlines                     |
| `--primary`            | `32 90% 30%`    | `41 96% 60%`    | CTAs, links, active nav       |
| `--primary-foreground` | white           | `30 60% 8%`     | text on primary               |
| `--brand-2`            | `7 93% 62%`     | `7 93% 66%`     | the mark, and one gradient stop |
| `--destructive`        | `0 72% 45%`     | `0 80% 65%`     | delete, disconnect            |
| `--success`            | `142 72% 26%`   | `142 62% 55%`   | confirmed state               |
| `--warning`            | `45 96% 27%`    | `45 95% 58%`    | caution state                 |
| `--ring`               | same as `--primary` | same as `--primary` | focus rings           |

`--card` stays pure white in light mode so cards stand out from the cream page.

**The drawn amber is not `--primary`, and cannot be.** The mark is drawn in
`hsl(39 95% 54%)` amber and `hsl(7 93% 62%)` coral. As text on white, that amber
measures **1.93:1**. It fails as link text, it fails as a section label, and
under white button text it fails again. `--primary` is that amber deepened until
it clears the bar in both directions at once: **6.19:1** as text on the card, and
**6.19:1** with white text on it. The drawn amber survives untouched in two
places where contrast does not apply, the mark itself and low-alpha washes.

The other measured values, so nobody has to re-derive them: `--foreground` is
17.34:1 on the card and 16.06:1 on the page. `--muted-foreground` is 7.31:1 on
the card. In dark mode `--foreground` is 16.97:1, `--muted-foreground` is
8.78:1, `--primary` as text is 10.69:1, and `--primary-foreground` on `--primary`
is 10.62:1. Dark mode's brand takes DARK text, not white, because the bright
amber it needs on a near-black page is far too light to sit under white.

**The three state tokens, and the one honest weakness in them.** `--destructive`,
`--success` and `--warning` are the only status colours. `--success` and
`--warning` are new: the badge, alert and toast primitives were carrying raw
`green-*`, `amber-*` and `orange-*` utilities, which stayed cold and un-themed
when the palette went warm. Soft fills are alpha over the token
(`bg-success/10 text-success`), so neither needs a `-foreground`. Measured as
text: success 6.02:1 light and 9.37:1 dark, warning 5.35:1 and 11.39:1,
destructive 5.81:1 and 5.49:1.

Dark `--destructive` was `0 70% 45%` until this edit and measured **3.08:1** on
the dark card, below the 4.5:1 floor. That was a live accessibility failure,
found while deriving the two new tokens, and it is fixed here rather than
carried forward.

**`--warning` sits close to `--primary`, and that is unavoidable.** The brand is
a warm ochre, so any warm caution colour is its neighbour: the two measure
1.16:1 against each other, which means they are near-identical in luminance.
There is no warm hue left that reads as "caution" and not as "brand". So the
rule is not a colour rule: **a warning state must always carry its icon, and
colour is never its only signal.** That is WCAG 1.4.1 regardless, and here it is
also the thing that makes the state legible at all. Never ship a warning that is
distinguished by hue alone, and never put a `--warning` fill next to a
`--primary` one.

**`--brand-2` is not a second primary.** It is the mark's coral, and it has
exactly two jobs: the mark, and the middle stop of `.surface-brand`. It carries
no text, no control, no state and no meaning. It is deliberately NOT wired to
`--destructive`: a coral that means "delete" on one screen and "brand" on
another teaches the reader nothing, and the red destructive stays red so the two
can never be confused.

**Brand discipline.** Neutrals use a warm tint across the whole app. Limit
saturated brand surfaces strictly. Only three utilities in `app.css` apply one.
Each uses an `hsl(var(--primary) / ...)` or `hsl(var(--brand-2) / ...)` gradient,
never a raw literal value:

- `.surface-brand` styles the ONE hero card on a screen. Use it once per screen,
  never twice. It runs ochre into coral, so the hero carries both of the mark's
  hues and nothing else in the app has to.
- `.surface-brand-soft` styles empty-state panels, paired with `border-dashed`.
- `.brand-glow` styles backdrops behind hero elements only.

Other components use `bg-card`. Standard cards, list rows, and inputs never take
a brand fill.

**One hero per screen, named:** The translator screen uses no hero at all, and
carries no `.surface-brand` element: its two cards match each other, which
section 3 explains. The Lists view uses its empty state panel, and once lists
exist, it uses no hero either. History also uses no hero. Placing a second
`.surface-brand` on any screen is a bug.

**Where the brand shows up outside a hero**, use only these token-based
treatments:

| Surface                          | Treatment                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Section labels above a block      | `text-[11px] font-semibold uppercase tracking-[0.11em] text-primary`, optional hairline at `bg-primary/20` |
| Card titles, app-wide             | `font-display` (Bricolage Grotesque) via the `CardTitle` primitive, never on a live figure |
| Interactive row or chip hover     | `hover:border-primary/40 hover:bg-primary/5`                                          |
| Active bottom-nav tab             | `bg-primary/5` plus an `after:` top rule at `bg-primary`                               |
| Active sidebar row                | the `SidebarMenuButton` `isActive` state, which already carries the brand              |

**The PWA colours are a hand-kept copy.** `public/manifest.webmanifest` and the
two `theme-color` meta tags in `app/root.tsx` carry resolved hex values, because
neither a manifest nor a meta tag can read a CSS custom property. They are the
light and dark `--background` values, `#f9f6f0` and `#0f0d0a`. Change them in
the same edit as the token or the browser chrome drifts from the page. This is
not hypothetical: the meta tag held `#057a78`, an openplate teal, straight
through the M186 blue repalette and was only caught when this palette landed.

---

## 3. Surfaces

Build all UI from these four v1 surfaces. To introduce a fifth surface, define
it here first.

**Translator surface.** The `/translate` screen, which the index `/` also
renders. It replaced the old search hero card, and the three rules below are the
whole recipe. Read them before changing anything on this screen.

*One column, at every width.* The language bar, then the input card, then the
answer card, stacked, all exactly the same width inside `mx-auto max-w-2xl`.
There is no second column at any breakpoint. A two-column grid stood here until
the relayout and it must not come back. It left half of a desktop first visit
empty, and it asked the language bar to line its edges up with a grid the bar
was not a cell of, which is not a thing a layout can do.

*The two cards are identical.* Both are `rounded-2xl border p-5`, and neither
carries a brand wash. The input card used to carry `.surface-brand` while the
answer card did not, which on a phone made a question and its answer read as two
different kinds of object. They match on purpose, so the pair reads as one
control and the reply it produced. This screen has no `.surface-brand` element
at all, and it is not a hero.

*The language bar is a three-cell grid,* `grid-cols-[1fr_auto_1fr]`: source
select, swap button, target select, with each select at `w-full`. It is not a
flex row, and `flex-wrap` is banned here. A wrapping flex row made the two
halves equal only by coincidence, sat each select 14px out of line with the card
beneath it, and dropped the target select onto its own line as the viewport
narrowed. A grid makes the halves equal by construction and can never wrap.

Both selects and the swap button carry a 44px minimum tap height, and the submit
button is full width below `sm`. This screen is used one-handed on a phone more
than anywhere else in the product.

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
- **`font-mono` for technical strings**: device and model ids, workflow ids,
  phonetic transcriptions, and code blocks. Victor Mono Variable is the face.
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
  feature tiles and `rounded-2xl` for the translator cards. Use `rounded-full`
  for pills, chips, and status dots.
- **`--radius` is `0.75rem`, and the whole ladder derives from it.** It was
  `0.5rem` until the Kenning mark landed: the mark is a stack of generously
  rounded cards, so the interface rounds to match. `xl` and `2xl` are derived in
  `@theme` too, which they were not before. Tailwind ships them as fixed values,
  so raising `--radius` alone would have made `rounded-lg` and `rounded-xl` the
  same curve and quietly collapsed the bottom of this ladder. Deriving all four
  steps shifts the ladder as a unit, which is why no component had to change to
  keep its place in it. Change `--radius` and every step moves together; hardcode
  a step and it stops moving.
- Shadows: Use `shadow-sm` at rest, `hover:shadow-md` on interactive cards, and
  `shadow-lg` on overlays. Never apply heavier shadows to elements at rest.
- **Shadows are warm-tinted, not black.** The `--shadow-*` scale is redefined in
  `@theme` over `hsl(28 40% 12%)` rather than Tailwind's neutral black. A pure
  black falloff on a cream page reads as a grey smudge sitting on top of the
  surface rather than as the surface lifting off it. Alpha still does all the
  work; the hue only stops the shadow going cold. Use the `shadow-*` utilities
  as normal, they pick this up for free. Never write a raw `box-shadow`.
- Interactive-card hover recipe: Apply `transition-all duration-200
  hover:shadow-md hover:border-primary/40`. Omit `dark:` prefixes because
  `primary` colors adapt to the active theme automatically.
- Page container: Use `mx-auto max-w-3xl px-4 sm:px-6`. The translator surface
  is narrower still at `max-w-2xl`, see section 3. Keep the single-column layout
  narrow. Full-width translation text is hard to read.
- Single column is the default and the burden of proof sits on a second one. A
  screen here holds a short question and a short answer, so a second column
  mostly buys empty space plus a second set of edges to keep aligned. The
  translator carried a `md:grid-cols-2` grid and gained nothing from it but the
  misalignment described in section 3.
- Vertical rhythm: Use `space-y-6` between page sections, `space-y-4` inside
  cards, and `gap-2` between form labels and inputs.

---

## 6. The shell

The wrapper in `app/components/app-wrapper.tsx` renders both responsive layouts.
Its header carries one account slot on every screen: a "Sign in" link to
`/sign-in` for an anonymous visitor, and the reader's email address, linking to
`/account`, for a signed-in one. An account is required for every search since
M184, so the shell shows the door rather than hiding it. The two doors are
`/sign-up` and `/sign-in`; sync is a consequence of holding an account and is
never presented as something a reader sets up.

Since M191 an account is created with an email address and a password rather
than a passphrase-derived identity. `/sign-up` and `/sign-in` are plain forms:
address and password, nothing revealed and nothing to write down. A reader who
forgets their password uses `/forgot-password` to request a mailed reset link;
no screen in this flow shows a secret the app cannot show again.

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
- No second `.surface-brand` on a screen that already uses one, and none at all
  on the translator surface.
- No two-column layout on the translator surface, at any breakpoint. See
  section 3.
- No `flex-wrap` on a row whose cells have to line up with something below
  them. Use a grid, so the alignment is a property of the layout rather than of
  the current viewport width.
- No label, chip or select rendered from the value the reader REQUESTED when the
  server resolved a different one. See principle 6.
