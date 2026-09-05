/**
 * The mailed single-use tokens: minting, hashing and their lifetimes.
 *
 * WHAT IS STORED IS THE DIGEST, NEVER THE TOKEN. The raw value exists in the
 * mail that carried it and in the URL the reader clicks, and nowhere else. A
 * dumped `user_tokens` table therefore replays nothing: an attacker holding a
 * digest cannot construct the link it was made from.
 *
 * SHA-256 IS THE RIGHT HASH HERE, and that is worth stating because a password
 * would need bcrypt. These tokens are 32 bytes of `randomBytes`, so there is no
 * guessable space to slow an attacker down in; the slow hash exists to defend
 * LOW-entropy secrets, and paying its cost on a high-entropy one buys nothing.
 *
 * PURE, and that is what makes it testable: no database, no clock of its own,
 * no request. `expiryFor` takes the instant it should measure from.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { UserTokenKind } from '#drizzle/schema';

/** Bytes of entropy per token. 32 is the same width the session cookie's secret carries. */
const TOKEN_BYTES = 32;

/** How long each kind stays clickable, in milliseconds. */
const TOKEN_TTL_MS = {
  /** A day: a confirmation mail is often opened on another device, hours later. */
  verify: 24 * 60 * 60 * 1000,
  /** An hour: a reset link is the one credential a mailbox can hand an attacker, so it lives as briefly as is usable. */
  reset: 60 * 60 * 1000,
} as const satisfies Record<UserTokenKind, number>;

/**
 * A fresh token, as the reader will receive it.
 *
 * @returns 64 hex characters of cryptographic randomness.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * The stored form of a token.
 *
 * @param token the raw token from a mail or a URL.
 * @returns its SHA-256 digest, hex encoded.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * When a token of this kind stops working.
 *
 * @param input.kind which link this is.
 * @param input.now the instant the token is minted.
 * @returns the absolute expiry.
 */
export function expiryFor(input: { kind: UserTokenKind; now: Date }): Date {
  return new Date(input.now.getTime() + TOKEN_TTL_MS[input.kind]);
}

/**
 * The absolute URL a mail carries.
 *
 * @param input.origin the site's origin, for example `https://kenning.altan.fyi`.
 * @param input.path the path the link lands on, leading slash included.
 * @param input.token the raw token.
 * @returns the link, with the token in a `token` query parameter.
 */
export function buildTokenUrl(input: { origin: string; path: string; token: string }): string {
  const url = new URL(input.path, input.origin);
  url.searchParams.set('token', input.token);
  return url.toString();
}
