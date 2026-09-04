#!/usr/bin/env node
/**
 * send-test-mail.ts, one real mail, on purpose, from a terminal.
 *
 * The unit tests prove the transport builds the right request against a
 * stubbed `fetch`. They cannot prove a key is valid, a domain is verified or
 * an inbox accepts the sender, and every one of those has failed silently
 * before. So this script sends the actual verification mail, in German, with a
 * dummy link, and prints the message id the service hands back.
 *
 * Usage:
 *   PIGEON_BASE_URL=http://100.64.0.1:3601 PIGEON_API_KEY=<key> \
 *     pnpm exec tsx scripts/send-test-mail.ts you@example.com
 *
 * Without both variables it prints the mail to the console instead of sending
 * it, which is the same fallback the app uses in development.
 */
import { verifyEmailTemplate } from '#app/emails/verify-email';
import { getServerT } from '#app/emails/i18n.server';
import { sendMail } from '#app/services/email.server';

/** A link that goes nowhere, so a stray click on a test mail cannot verify anything. */
const DUMMY_URL = 'https://translate.altan.fyi/verify?token=test-token-not-valid';

async function main(): Promise<void> {
  const to = process.argv[2];
  if (to === undefined || to === '') {
    throw new Error('usage: tsx scripts/send-test-mail.ts <recipient@example.com>');
  }

  const { subject, text } = verifyEmailTemplate(getServerT('de'), { url: DUMMY_URL });
  const { messageId } = await sendMail({ to, subject, text });
  console.log(`messageId ${messageId}`);
}

await main();
