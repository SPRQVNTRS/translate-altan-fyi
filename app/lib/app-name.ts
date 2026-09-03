/**
 * The product name, as one constant.
 *
 * A lowercase wordmark and a proper noun, so it is never translated and never
 * capitalised by a stylesheet.
 *
 * `app/components/app-wrapper.tsx` holds an identical private `APP_NAME` for
 * the signed-in shell. Two copies of a wordmark is one too many, and that file
 * should import this one, but it was being edited in another thread when this
 * module was written. Folding it in is owed work, not a decision.
 */
export const APP_NAME = 'translate';
