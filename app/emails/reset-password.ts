/**
 * reset-password.ts, the mail that carries a password reset link.
 *
 * The twin of `./verify-email.ts`, which carries the reasoning both files
 * share: the words live in the catalogs under `email.reset.*`, the translator
 * arrives as a parameter rather than being resolved here, and the link is the
 * only URL in the message.
 */

/** A rendered mail: the two fields `sendMail` takes. */
export type RenderedMail = {
  subject: string;
  text: string;
};

/** The blank line between the parts of a plain-text mail. */
const PARAGRAPH_BREAK = '\n\n';

/**
 * Renders the password reset mail.
 *
 * @param t - a translator for the reader's language.
 * @param url - the reset link, the only URL in the message.
 * @returns the subject line and the plain-text body.
 */
export function resetPasswordTemplate(t: (key: string) => string, { url }: { url: string }): RenderedMail {
  return {
    subject: t('email.reset.subject'),
    text: [
      t('email.reset.greeting'),
      t('email.reset.body'),
      t('email.reset.action'),
      url,
      t('email.reset.ignore'),
      t('email.reset.signoff'),
    ].join(PARAGRAPH_BREAK),
  };
}
