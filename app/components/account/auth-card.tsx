/**
 * The one card every account screen is drawn in, and the three pieces that go
 * inside it.
 *
 * IT IS CENTRED, AND THAT IS A FIX RATHER THAN A PREFERENCE. The forms these
 * screens replaced sat inside the app shell's normal content column, which is
 * left aligned under a full-width header, so a narrow form appeared pushed to
 * one side of an otherwise empty page. `mx-auto` with a `max-w-md` puts it
 * where a reader looks for it.
 *
 * SEVEN SCREENS, ONE SHAPE. Sign-up, confirm, sign-in, sign-out, forgot, reset
 * and the signed-out half of `/account` all render a heading, a sentence, a
 * short form and one line of small print. Sharing the shape is what keeps the
 * seventh from quietly drifting a heading level or a gap size away from the
 * first six.
 *
 * NO STATE, NO DATA, NO ROUTER. These are layout components: every screen owns
 * its own `<Form>`, its own action and its own copy. That is deliberate, and it
 * is why the file has no `useTranslation` call anywhere in it.
 */
import type { ReactNode } from 'react';

import { H1, H2 } from '#app/components/typography';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';

export interface AuthCardProps {
  /** The heading. */
  title: string;
  /**
   * Which heading element the title is.
   *
   * `h1` BY DEFAULT, because the five doors render under `PublicWrapper`, which
   * draws no page heading of its own, so this card IS the page. `/account` is
   * the exception: it sits in the app shell, whose header already renders the
   * route title as the page's `h1`, so it passes `h2` and the document keeps
   * one top-level heading.
   */
  headingLevel?: 'h1' | 'h2';
  /** One sentence under the heading. Optional: a form that needs no explanation should carry none. */
  description?: string;
  /** Optional: a screen that only reports an outcome carries a heading and a sentence and nothing else. */
  children?: ReactNode;
  /** The small print under the card: the link to the other door, usually. */
  footer?: ReactNode;
}

/** One size for the card's heading, whichever element it turns out to be. */
const HEADING_CLASSES = 'font-display text-lg font-semibold tracking-tight';

/** The centred card. */
export function AuthCard({ title, headingLevel = 'h1', description, children, footer }: AuthCardProps) {
  // THE VARIANTS ARE THE UNDECORATED ONES, not the defaults. `H1`'s default
  // carries `lg:text-5xl`, which `cn` cannot merge away with a base-breakpoint
  // `text-lg`, so the card heading tripled in size on a wide screen; `H2`'s
  // default carries `border-b pb-2`, which drew a rule across the card. Both
  // are decisions those variants make for a document page, and this is a card.
  const heading =
    headingLevel === 'h1' ?
      <H1 variant="subtlePageHeader" className={HEADING_CLASSES}>{title}</H1>
    : <H2 variant="subSectionHeader" className={HEADING_CLASSES}>{title}</H2>;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="rounded-xl border bg-card p-6">
        {heading}
        {description !== undefined && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
        {children !== undefined && <div className="mt-6 flex flex-col gap-5">{children}</div>}
      </div>
      {footer !== undefined && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}

export interface AuthFieldProps {
  /** The `id` and the `name`. One value for both, so a label can never point at a field the form does not send. */
  name: string;
  label: string;
  type: 'email' | 'password';
  autoComplete: string;
  /** One line under the field. The password rule lives here rather than in an error nobody reads first. */
  hint?: string;
  defaultValue?: string;
}

/**
 * One labelled field.
 *
 * `name` IS THE `id`. A label whose `htmlFor` names a field that is not
 * submitted is the accessibility bug this shape cannot express, and every
 * screen here has at least two password inputs on it at some point.
 */
export function AuthField({ name, label, type, autoComplete, hint, defaultValue }: AuthFieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        defaultValue={defaultValue}
      />
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The refusal line.
 *
 * `role="alert"` so a screen reader is told about it when it appears after a
 * submit, rather than only on the next deliberate read of the page.
 */
export function AuthNotice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
