import type { HTMLAttributes, PropsWithChildren } from 'react';
import { cn } from '#app/lib/utils';

// --- Common Base ---
const baseHeadingClasses = 'scroll-m-20 tracking-tight';

// --- H1 ---
type H1Variant =
  | 'default'
  | 'pageHeader'
  | 'pageHeaderBold'
  | 'subtlePageHeader'
  | 'loginHeader'
  | 'errorBoundary'
  | 'pageHeaderWithMargin';

const h1VariantClasses = {
  default: 'text-4xl font-extrabold lg:text-5xl',
  pageHeader: 'text-2xl font-semibold text-zinc-900 dark:text-zinc-100',
  pageHeaderBold: 'text-2xl font-bold',
  subtlePageHeader: 'text-2xl font-semibold', // No text color by default
  loginHeader: 'text-center text-xl font-bold',
  errorBoundary: 'text-xl font-bold',
  pageHeaderWithMargin: 'text-2xl font-semibold mb-6',
} satisfies Record<H1Variant, string>;

type H1Props = PropsWithChildren<
  HTMLAttributes<HTMLHeadingElement> & {
    variant?: H1Variant;
  }
>;

export function H1({ children, className, variant = 'default', ...props }: H1Props) {
  return (
    <h1 className={cn(baseHeadingClasses, h1VariantClasses[variant], className)} {...props}>
      {children}
    </h1>
  );
}

// --- H2 ---
type H2Variant = 'default' | 'sectionHeader' | 'subSectionHeader' | 'subSectionHeaderWithMargin' | 'keywordsHeader';

const h2VariantClasses = {
  default: 'border-b pb-2 text-3xl font-semibold first:mt-0',
  sectionHeader: 'text-xl font-semibold text-zinc-900 dark:text-zinc-100',
  subSectionHeader: 'text-lg font-semibold',
  subSectionHeaderWithMargin: 'text-lg font-semibold mb-2',
  keywordsHeader: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4',
} satisfies Record<H2Variant, string>;

type H2Props = PropsWithChildren<
  HTMLAttributes<HTMLHeadingElement> & {
    variant?: H2Variant;
  }
>;

export function H2({ children, className, variant = 'default', ...props }: H2Props) {
  return (
    <h2 className={cn(baseHeadingClasses, h2VariantClasses[variant], className)} {...props}>
      {children}
    </h2>
  );
}

// --- H3 ---
type H3Variant = 'default' | 'cardHeader' | 'subSectionHeader' | 'websiteAttachmentHeader';

const h3VariantClasses = {
  default: 'text-2xl font-semibold',
  cardHeader: 'text-lg font-medium',
  subSectionHeader: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4',
  websiteAttachmentHeader: 'font-medium text-zinc-900 dark:text-zinc-100', // Removed scroll-m-20 tracking-tight here as it was font-medium only before
} satisfies Record<H3Variant, string>;

type H3Props = PropsWithChildren<
  HTMLAttributes<HTMLHeadingElement> & {
    variant?: H3Variant;
  }
>;

export function H3({ children, className, variant = 'default', ...props }: H3Props) {
  // Apply base only if not websiteAttachmentHeader which has specific styling
  const base = variant === 'websiteAttachmentHeader' ? '' : baseHeadingClasses;
  return (
    <h3 className={cn(base, h3VariantClasses[variant], className)} {...props}>
      {children}
    </h3>
  );
}

// --- P ---
type PVariant = 
  | 'default'
  | 'lead'
  | 'subtle'
  | 'small'
  | 'muted';

const pVariantClasses = {
  default: 'leading-7',
  lead: 'text-xl text-muted-foreground',
  subtle: 'text-sm text-muted-foreground',
  small: 'text-sm font-medium leading-none',
  muted: 'text-sm text-muted-foreground',
} satisfies Record<PVariant, string>;

type PProps = PropsWithChildren<
  HTMLAttributes<HTMLParagraphElement> & {
    variant?: PVariant;
  }
>;

export function P({ children, className, variant = 'default', ...props }: PProps) {
  return (
    <p className={cn(pVariantClasses[variant], className)} {...props}>
      {children}
    </p>
  );
}
