# translate.altan.fyi Design Language

Adapted from openplate (`openplate/DESIGN.md`), which is a sibling product and shares the family
DNA: a teal-tinted neutral scale carrying every surface, a single teal brand accent, and a
display serif that gives the chrome its character. The overall feel is "calm study tool", clean,
text-forward, unhurried. It is not a playful consumer app and it is not a dense dashboard.

The tokens, the shadcn primitives and the shell came over whole from openplate, so the two
products feel related and the component library does not have to be rediscovered. What follows is
the charter for THIS product. When adding UI, follow the recipes here instead of inventing new
ones.

---

## 0. Two rules that override everything

These are operator rules. They are enforced by a unit test (`tests/unit/design-rules.test.ts`),
not by review, because review forgets.

1. **Never use a thick left border to accentuate an element.** No `border-l-4`, no
   `border-l-[3px]`, no `border-left: 4px`, no `border-left: 3px`. To lift a block, use a
   background wash, a full hairline, or an icon.
2. **Never use em dashes in copy, use a comma instead.** This covers user-facing strings, code
   comments and CLI output alike.

---

## 1. Principles

1. **Neutrals carry the chrome, teal carries the brand.** Almost everything is neutral. Teal
   appears only where attention belongs: the primary button, the active nav item, the focus ring,
   links, and the one hero card per screen.
2. **The word is the subject.** A search result is a piece of writing, not a data row. Set it with
   real typographic care: readable measure, generous leading, clear hierarchy between the
   translation, the explanation and the examples.
3. **Feedback is mandatory.** Every async action shows its state. A pending button gets a spinner
   and a progressive label, a mutation confirms with a toast, a destructive action gets a real
   dialog. `window.confirm` is banned. Nothing the user triggers may look frozen.
4. **Dark mode is a first-class parallel palette**, not an inversion. Every recipe below has an
   explicit dark variant, and every new component ships both.
5. **Soft but dense.** Generous radii, subtle shadows, compact information density.

---

## 2. Color tokens

Semantic tokens live in `app/app.css` as HSL triplets (shadcn convention). Every surface and
hairline sits on the brand's own hue (192 degrees) at low chroma, so the chrome, the page and the
cards read as one teal-tinted family instead of a teal accent dropped onto a cold grey app.

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

`--card` stays pure white in light mode so cards lift off the tinted page. `--foreground` clears
15:1 on both the card and the page, `--muted-foreground` clears about 7.6:1 on white and 7:1 in
dark.

Openplate's macro, adherence and carb-status token families did NOT come over. They describe food,
which this product knows nothing about. Do not port them back "for later". A token earns its place
when a screen needs it.

**Brand discipline.** The neutrals are teal-tinted everywhere, but a *saturated* teal surface is
rationed. Exactly three utilities may paint one, all defined in `app.css`, all expressed as
`hsl(var(--primary) / ...)` gradients, never a literal:

- `.surface-brand` for the ONE hero card per screen. One per screen, never two.
- `.surface-brand-soft` for empty-state panels, paired with `border-dashed`.
- `.brand-glow` for a hero backdrop only.

Everything else keeps `bg-card`. Ordinary cards, list rows and inputs never get a brand fill.

**One hero per screen, named:** Search gets the search hero card. Lists gets its empty state or,
once lists exist, nothing (a list of rows has no hero). History likewise. Adding a second
`.surface-brand` to a screen is a bug.

**Where the brand shows up outside a hero**, these are the only sanctioned treatments, all
token-only:

| Surface                          | Treatment                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Section labels above a block      | `text-[11px] font-semibold uppercase tracking-[0.11em] text-primary`, optional hairline at `bg-primary/20` |
| Card titles, app-wide             | `font-display` (Fraunces) via the `CardTitle` primitive, never on a live figure       |
| Interactive row or chip hover     | `hover:border-primary/40 hover:bg-primary/5`                                          |
| Active bottom-nav tab             | `bg-primary/5` plus an `after:` top rule at `bg-primary`                               |
| Active sidebar row                | the `SidebarMenuButton` `isActive` state, which already carries the brand              |

---

## 3. Surfaces

The four v1 surfaces and the recipe each one is built from. Adding a fifth means adding a row
here first.

**Search hero card.** The one `.surface-brand` on the Search screen. `rounded-2xl`, a large
`Input`, a primary `Button`, and one muted line underneath saying what the search will do. It is
the first thing on the page and the reason the app exists, so it gets the brand wash and nothing
else on that screen does.

**Entry card** (a word or phrase and its translation). `rounded-lg border bg-card shadow-sm`,
`hover:shadow-md hover:border-primary/40 transition-all duration-200`. Inside, in order: the
source term as the `CardTitle` in `font-display`, the translation at `text-base`, the explanation
at `text-sm text-muted-foreground`, then the examples. Sense chips sit under the title as a row
of `rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary` pills, one per distinct sense of
the word. A chip is a filter and a label at once, so it is never the only place a sense is named.

**List row.** A saved word inside a list. `flex items-center gap-3 rounded-lg px-3 py-2`, the term
at `text-sm font-medium`, the translation at `text-sm text-muted-foreground truncate`, the row
hover from the table above. Rows are separated by their own hover state and a hairline, never by a
left border.

**History row.** The same skeleton as a list row plus a right-aligned relative timestamp at
`text-xs text-muted-foreground tabular-nums`. History is chronological and repetitive, so it is set
quieter than a list: no card, no shadow, just rows on the page.

---

## 4. Typography

- **Body font: Inter Variable (`font-sans`) on `<body>`.** Victor Mono Variable is available as
  `font-mono` for genuinely technical strings, phonetic transcriptions and code. Inter is the
  prose and UI voice.
- **Display serif: Fraunces (`font-display`)**, self-hosted from `public/fonts/`. It carries the
  wordmark, page titles and card titles, which is the cheapest way to give screens past the hero
  some brand character.
  **Never on a live figure.** The Fraunces subset has no tabular-figure feature, so digits jitter
  in width as they update. Any number that changes stays in `font-sans` with `tabular-nums`.
- Fonts are **self-hosted**: Inter and Victor Mono via `@fontsource-variable/*` imports in
  `root.tsx`, Fraunces via the `@font-face` block in `app/app.css`. Never a Google Fonts link, never
  a CDN. This is a privacy rule, not a performance one.
- Scale (plain Tailwind, applied consistently):
  - Page title: `text-2xl font-semibold tracking-tight`
  - Hero: `text-4xl font-bold tracking-tight sm:text-5xl`
  - Card title: `text-lg font-semibold`
  - Body: `text-sm` default, `text-base` for a translation or an example sentence
  - Meta, labels, badges: `text-xs`, muted meta: `text-xs text-muted-foreground`
- Emphasis weight is `font-semibold`.
- **Foreign-language text carries a `lang` attribute.** A screen reader switching voice for a
  German example sentence is the difference between the app working and not working. This is not
  optional polish.

---

## 5. Shape, elevation, spacing

- Radii: `rounded-md` buttons, inputs and thumbnails, `rounded-lg` cards and dialogs (dominant),
  `rounded-xl` feature tiles, `rounded-2xl` the search hero, `rounded-full` pills, chips and dots.
  `--radius: 0.5rem` stays.
- Shadows: `shadow-sm` at rest, `hover:shadow-md` on interactive cards, `shadow-lg` for overlays.
  Never heavier at rest.
- Interactive-card hover recipe: `transition-all duration-200 hover:shadow-md
  hover:border-primary/40`. No `dark:` variant is needed, `primary` is already per-theme.
- Page container: `mx-auto max-w-3xl px-4 sm:px-6`. This is a focused single-column app, keep it
  narrow. A translation reads badly at full width.
- Vertical rhythm: `space-y-6` between page sections, `space-y-4` within cards, `gap-2` from a
  label to its input.

---

## 6. The shell

One wrapper, `app/components/app-wrapper.tsx`, renders both layouts:

- **Mobile:** a fixed bottom tab bar (`app/components/bottom-nav.tsx`) with Search, Lists and
  History, plus a left-slide drawer holding the full map including Settings and Account.
- **Desktop (`md` and up):** a collapsible sidebar (`app/components/app-sidebar.tsx`) showing the
  same map, with the configuration group below a rule.

All three nav surfaces read ONE catalog, exported from `app-sidebar.tsx`. A label or an href
changes in one place. Two navs disagreeing about a destination is a bug, and it is the bug this
catalog exists to prevent.

The bottom bar has three equal flat tabs. Openplate's raised centre button did not come over,
because this app has no single flagship verb that is tapped several times a session.

---

## 7. Motion and feedback (non-negotiables)

- **Pending buttons:** every submit button disables and shows `Loader2` with `animate-spin` plus a
  progressive label ("Searching...", "Saving..."). No bare text swaps.
- **Long operations** (a model call for an explanation): staged status copy driven by elapsed
  time. Never leave a silent multi-second gap.
- **Toasts** (sonner, mounted once in `root.tsx`): a success confirmation for every mutation.
  Theme-aware, never a hardcoded `theme="light"`. The bottom of the screen belongs to the tab bar,
  so toasts never cover it.
- **Destructive actions:** an `AlertDialog` confirmation with a destructive button and a pending
  spinner.
- **Radix enter and exit:** `tw-animate-css` data-state animations as shipped.
- **View transitions:** every in-app link goes through `app/components/link.tsx`, which defaults
  react-router's `viewTransition` to true. The effect is a 200ms opacity cross-fade of the whole
  document, nothing else. No shared-element morphs until something actually has a stable
  counterpart across two routes.
- **Reduced motion** is honoured through the media queries in `app.css`, which kill every view
  transition and every toast animation. The app has no in-app motion toggle, so that media query
  is the only switch.
- **The waiting vocabulary** is two classes in `app.css`, `.pulse-soft` and `.loading-dots`, used
  only where the app is genuinely waiting. Never as decoration on static content.

---

## 8. Dark mode

Class-based (`.dark` on `<html>`), with a hand-rolled localStorage toggle offering light, dark and
system. An inline boot script in `root.tsx` applies the class before first paint, so there is no
flash. Rules: every new component ships both palettes, and overlays and toasts resolve the active
theme rather than hardcoding one.

---

## 9. Voice

One register everywhere: **warm, plainspoken, non-shaming, and literally true.** Rules, in
priority order:

1. **Never imply the user failed.** Not knowing a word is the normal case, it is why the app
   exists. Copy describes the WORD or the DATA, never the person. No streak scolding, no "you
   haven't studied since...".
2. **Never claim more than is true.** If the dictionary has no entry, say the dictionary has no
   entry. If a translation came from a model rather than a curated source, say so where the user
   can see it. Rewrite honesty copy for warmth, never for comfort.
3. **Sentence case, ordinary words.** No Title Case buttons. No operator jargon ("instance",
   "invalid", "payload") anywhere a normal user can reach. "Log in" everywhere, never "Login",
   never a second synonym.
4. **Confirmations end in a period and state the outcome.** "Saved to your list." "List deleted."
5. **Empty is not an error.** "Your saved words will collect here." Never "No data", never
   "Nothing found", never "No results".
6. **"Coming soon" is a dead end.** Say what is not built, what works instead today, and how long
   the workaround takes.
7. **One phrasing per idea.** A sentence that appears on two screens is a bug in one of them.
8. **All copy and all translations go through `pnpm -C djinn wordsmith`.** Never hand-written,
   never hand-translated. The tool refuses a run that drops a key or translates a placeholder,
   which is exactly the failure a human makes.

---

## 10. Don'ts

- No em dashes. See section 0.
- No thick left border accents. See section 0.
- No new accent colors. Brand washes are allowed but rationed to the three `app.css` utilities, in
  the places section 2 lists, and never as a raw color literal in a component.
- No `text-teal-*`, `bg-emerald-*` or `bg-zinc-*` literals in app code. Every brand and neutral
  value is a token. Color literals belong in `app/app.css` and nowhere else.
- No `window.confirm` and no `window.alert`.
- No unlabeled spinners as page content. A spinner attaches to the thing that is pending.
- No Google Fonts and no CDN assets. Self-hosted only.
- No new one-off card or badge class combos when a recipe above fits.
- No second `.surface-brand` on a screen that already has one.
