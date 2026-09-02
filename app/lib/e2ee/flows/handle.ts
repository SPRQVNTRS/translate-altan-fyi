/**
 * COPIED, NOT SHARED. Source: openplate/app/lib/sync/handle.ts @ 68e893ac71d25ad7ff42280773ea0ec94f4f700e.
 * See .adr/0008-e2ee-sync-copied-not-extracted.md. Fixes belong upstream first,
 * then here. Do not let the two drift.
 */
/**
 * The account handle: minted here, on the device, and never an email address.
 *
 * ── Why the client mints it ───────────────────────────────────────────────
 *
 * M181 took email out of `openplate-sync` entirely. What is left is a handle
 * plus a passphrase, and the handle exists only to name a row — the service
 * has no opinion about it beyond "non-empty, no `@`, length-bounded, unique".
 * Asking a person to invent one would produce either their email address or
 * their first name, and the first of those is exactly the PII the milestone
 * removed. So the default is generated, and the user may edit it.
 *
 * ── Why Crockford base32 ─────────────────────────────────────────────────
 *
 * For the reason that alphabet exists: it omits `I`, `L`, `O` and `U`, so a
 * handle read off a screen, written on a card, or dictated down a phone does
 * not come back as a different handle. The table is imported from
 * `engine/crypto/base32.ts` rather than restated — that module's header is
 * explicit that a second copy which drifted by one character is how two
 * different values come to render the same string, and the recovery code
 * printed beside the handle on the same account card uses this same table.
 *
 * ── The `@` rule lives in two places on purpose ──────────────────────────
 *
 * The server's rejection (`openplate-sync/src/accounts/auth-input.ts`) is the
 * CONTRACT; the one below is a COURTESY, so a person who types their email
 * address into the handle box is told immediately instead of after a round
 * trip. Both must exist: dropping the server rule would let the column drift
 * back into an address register, and dropping this one would make the only
 * feedback a `400`.
 */
import { CROCKFORD_BASE32_ALPHABET } from '#app/lib/e2ee/crypto/base32';

/**
 * Handle length, in characters.
 *
 * Ten Crockford characters is 50 bits. The collision margin against a
 * server-side unique index is what sets the floor: at 50 bits a self-hosted
 * instance would need on the order of a million accounts before a single
 * duplicate became likely, and a duplicate is a recoverable `409` at signup
 * rather than a loss. The ceiling is human: this string is printed on the
 * account card and typed on another device, so every character costs
 * transcription.
 */
export const HANDLE_LENGTH = 10;

/** Matches the service's own bound (`auth-input.ts`'s `MAX_HANDLE_LENGTH`), so a handle this client accepts is one the server will. */
export const MAX_HANDLE_LENGTH = 64;

/**
 * The generated handle's alphabet — the single frozen Crockford table, shared
 * with the recovery code and the share-key fingerprint.
 */
const HANDLE_ALPHABET = CROCKFORD_BASE32_ALPHABET;

/** Fills a byte buffer with randomness. Injected so the generator is testable without stubbing a global. */
export type RandomBytes = (length: number) => Uint8Array;

function webCryptoRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Canonicalises a handle the way the server does (`normalizeHandle` there):
 * NFKC, then trim, then lowercase.
 *
 * THE ORDER MATTERS. NFKC can turn a full-width space into an ordinary one, so
 * normalising before trimming is what makes `"ａ　"` collapse to `a`
 * rather than to `a ` — and a client that canonicalised differently from the
 * server would show the user one handle and register another.
 */
export function normalizeHandle(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/** Why a handle was refused, or `null` when it is acceptable. The caller turns this into copy. */
export type HandleProblem = 'empty' | 'too-long' | 'email-shaped';

/**
 * Validates a candidate handle with the same rule the service enforces.
 *
 * Returns the REASON rather than a message: this module is pure and has no
 * translator, and the three cases need three different sentences.
 */
export function findHandleProblem(raw: string): HandleProblem | null {
  const handle = normalizeHandle(raw);
  if (handle.length === 0) return 'empty';
  if (handle.length > MAX_HANDLE_LENGTH) return 'too-long';
  // The one rule that is about meaning rather than shape: a handle is not an
  // address, and this service never stores a mailbox.
  if (handle.includes('@')) return 'email-shaped';
  return null;
}

/**
 * Mints a fresh handle.
 *
 * NO MODULO BIAS: the alphabet has exactly 32 entries and 256 is a whole
 * multiple of 32, so masking each random byte with `0x1f` selects uniformly.
 * Rejection sampling would be the fix if the table were ever resized, and it
 * is not, because the table is frozen.
 *
 * The result is lowercase because that is the server's canonical form — a
 * handle shown in one case and stored in another is a handle the user cannot
 * verify they typed correctly.
 */
export function generateHandle(randomBytes: RandomBytes = webCryptoRandomBytes): string {
  const bytes = randomBytes(HANDLE_LENGTH);
  let handle = '';
  for (const byte of bytes) {
    handle += HANDLE_ALPHABET[byte & 0x1f];
  }
  return handle.toLowerCase();
}
