/**
 * The claims the legal copy must keep making, and the ones it must never make.
 *
 * WHY A TEST AND NOT A REVIEW. The copy in `app/locales/<locale>/legal.json` is
 * GENERATED (`pnpm -C djinn wordsmith`), so a re-run can quietly reword a
 * sentence out of existence. Two classes of change matter enough to fail the
 * gate:
 *
 *   1. The privacy policy must keep stating what the operator HOLDS. Since
 *      ADR-0011 the account is plain, so the two facts a rewrite drifts away
 *      from are the password hash in the account record and the READABLE sync
 *      copy of the lists, notes and history. Both are the unflattering half,
 *      which is exactly why a regenerated sentence loses them first, the same
 *      failure M175/04 caught when the flattering half was encryption.
 *   2. Nothing commercial may come back. Payment was scrapped on 2026-09-01 and
 *      these documents moved here from the deleted M174 minus everything about
 *      money. A plan or refund clause reappearing is a factual error about a
 *      product that cannot take a payment.
 *   3. The old encryption promise may never return. M191/04 deleted every
 *      sentence claiming the server could not read the personal data, because
 *      it now can. That vocabulary is FORBIDDEN, not merely unrequired, so a
 *      copy run that resurrects it fails rather than passes quietly.
 *
 * The assertions are on TOPIC WORDS, never on a whole sentence, so a legitimate
 * rewording passes and a dropped disclosure does not. The vacuity guard below
 * is what stops a mistyped path from making all of it green.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Reads one catalogue as raw text: these assertions are about the prose, not the shape. */
function readLegalCopy(locale: string): string {
  return readFileSync(new URL(`app/locales/${locale}/legal.json`, `file://${REPO_ROOT}`), 'utf8');
}

const english = readLegalCopy('en');
const german = readLegalCopy('de');

/** A claim the privacy copy has to keep making, and the words that carry it. */
const REQUIRED_CLAIMS: readonly { claim: string; pattern: RegExp }[] = [
  { claim: 'typed queries reach the server in plaintext', pattern: /plaintext/i },
  { claim: 'the account record holds a password hash', pattern: /password hash/i },
  { claim: 'the synced copy is readable by the operator', pattern: /readable/i },
  { claim: 'no account is required', pattern: /no account|without an account/i },
  { claim: 'the LLM provider is named', pattern: /gemini/i },
  { claim: 'the AI Act disclosure duty is stated', pattern: /article 50/i },
  { claim: 'the search history stays on the device', pattern: /history/i },
  { claim: 'the abuse counter is described', pattern: /hash of your address|counter/i },
  { claim: 'the hosting location is named', pattern: /hetzner/i },
  { claim: 'the CC BY attribution obligation is passed through', pattern: /attribution/i },
];

/** Vocabulary that cannot be true of this product, in either language. */
const FORBIDDEN = /stripe|subscription|refund|pricing|paid plan|encrypt|verschlüssel|passphrase/i;

/** The German counterpart of each claim above that names a concrete stored thing. */
const REQUIRED_GERMAN_CLAIMS: readonly { claim: string; pattern: RegExp }[] = [
  { claim: 'the account record holds a password hash', pattern: /Passwort-Hash/i },
  { claim: 'the synced copy is readable by the operator', pattern: /lesbar/i },
  { claim: 'typed queries reach the server in plaintext', pattern: /Klartext/i },
];

describe('legal copy', () => {
  it('reads both catalogues (guards every assertion below)', () => {
    assert.ok(english.length > 5000, `en/legal.json is ${english.length} characters, expected a full document`);
    assert.ok(german.length > 5000, `de/legal.json is ${german.length} characters, expected a full document`);
  });

  for (const { claim, pattern } of REQUIRED_CLAIMS) {
    it(`states in English that ${claim}`, () => {
      assert.ok(pattern.test(english), `en/legal.json no longer matches ${String(pattern)}`);
    });
  }

  for (const { claim, pattern } of REQUIRED_GERMAN_CLAIMS) {
    it(`states in German that ${claim}`, () => {
      assert.ok(pattern.test(german), `de/legal.json no longer matches ${String(pattern)}`);
    });
  }

  it('carries no payment, plan or encryption vocabulary, in either language', () => {
    const hits = [
      ...(FORBIDDEN.test(english) ? ['app/locales/en/legal.json'] : []),
      ...(FORBIDDEN.test(german) ? ['app/locales/de/legal.json'] : []),
    ];
    assert.deepEqual(
      hits,
      [],
      `This product takes no payment and encrypts nothing on the device. Remove that copy from: ${hits.join(', ')}`,
    );
  });

  it('discriminates (guards the three matchers themselves)', () => {
    assert.ok(REQUIRED_CLAIMS.every(({ pattern }) => !pattern.test('a document about nothing at all')));
    assert.ok(REQUIRED_GERMAN_CLAIMS.every(({ pattern }) => !pattern.test('ein Dokument ohne jeden Inhalt')));
    assert.ok(FORBIDDEN.test('cancel your subscription'));
    assert.ok(FORBIDDEN.test('the blob is encrypted on your device'));
    assert.ok(FORBIDDEN.test('der Datenblock ist verschlüsselt'));
    assert.ok(!FORBIDDEN.test('the service is free of charge'));
  });
});
