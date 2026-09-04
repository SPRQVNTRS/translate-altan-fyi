/**
 * verify-email.ts, the mail that confirms a new address.
 *
 * Every word comes from the catalogs under `email.verify.*`, so the two
 * languages are one template and cannot drift apart. The file therefore holds
 * no English at all, and adding a third language means adding a catalog and
 * nothing else.
 *
 * It takes `t` rather than a language code. The caller has the request, so the
 * caller has the only trustworthy language; a module that resolved the
 * language itself would have to reach for the i18next singleton, which is one
 * process-wide instance and would serve one reader's language to the next
 * (the same trap `app/i18n/meta-title.ts` documents). `getServerT` in
 * `./i18n.server.ts` builds a `t` from a language code for callers, such as a
 * background job, that have nothing else.
 *
 * The parameter is typed as the single call this file makes, which i18next's
 * own `TFunction` satisfies, so a route passes its `t` straight in and a test
 * passes a plain lookup function without a cast.
 *
 * No HTML part, no images, no tracking pixel. The link is the only URL, and it
 * sits on its own line so every mail client makes it clickable and no client
 * wraps it into a broken one.
 */

/** A rendered mail: the two fields `sendMail` takes. */
export type RenderedMail = {
  subject: string;
  text: string;
};

/** The blank line between the parts of a plain-text mail. */
const PARAGRAPH_BREAK = '\n\n';

/**
 * Renders the verification mail.
 *
 * @param t - a translator for the reader's language.
 * @param url - the verification link, the only URL in the message.
 * @returns the subject line and the plain-text body.
 */
export function verifyEmailTemplate(t: (key: string) => string, { url }: { url: string }): RenderedMail {
  return {
    subject: t('email.verify.subject'),
    text: [
      t('email.verify.greeting'),
      t('email.verify.body'),
      t('email.verify.action'),
      url,
      t('email.verify.ignore'),
      t('email.verify.signoff'),
    ].join(PARAGRAPH_BREAK),
  };
}
