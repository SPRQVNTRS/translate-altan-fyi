/**
 * The local development seed.
 *
 * Run it with `pnpm drizzle:seed`. It creates TWO verified accounts, matching
 * the pair selfhostedworld and lowcarbcheck both seed, so a laptop with no
 * mail transport can still sign in as either an operator or an ordinary
 * reader:
 *
 *   - `superadmin@example.com`, with `is_superadmin` set, reaching the
 *     operator screens under `/super`;
 *   - `user@example.com`, an ordinary account, for testing what a signed-in
 *     reader who is NOT an operator sees.
 *
 * Nothing else is seeded, on purpose:
 *
 *   - every OTHER user signs themselves up and confirms an address by
 *     clicking a mailed link, so a seeded row for anyone but these two fixed
 *     accounts would be an account nobody can prove they own;
 *   - the DICTIONARY is imported, not invented. It has its own restore path,
 *     `scripts/dictionary-restore.sh` against the checked-in
 *     `dictionary-seed-2026-09-02.dump`, and this script must never touch a
 *     dictionary table.
 *
 * ── Why sign-up is otherwise a dead end on a laptop ────────────────────────
 *
 * The app's main screen is gated: any non-empty query redirects to
 * `/sign-in` unless an account row exists with a verified email
 * (`users.email_verified_at`). A normal sign-up mails a confirmation link,
 * and a local dev box has no mail transport to receive it on. This script is
 * the escape hatch: it writes the rows `/sign-up` would eventually produce,
 * with `emailVerifiedAt` already set.
 *
 * ── Idempotent, not "run-once" ─────────────────────────────────────────────
 *
 * A second run UPDATEs the same two rows' password hash and verification
 * timestamp instead of skipping them. That is deliberate: a developer who
 * forgot the seeded password re-runs this script to reset it, rather than
 * hand-writing SQL or deleting the rows first. The upsert is data-driven, over
 * the `SEED_ACCOUNTS` list below, rather than one hand-copied block per
 * account: a third seeded account, if one is ever needed, is a new list entry
 * and not a second near-duplicate function.
 *
 * ── The stale `dev@example.com` row ─────────────────────────────────────────
 *
 * This script used to seed a single `dev@example.com` account. A developer
 * who seeded before this change has that row sitting in their local database
 * as a third, now-undocumented account. This script deletes it explicitly on
 * every run and says so in its output, so nobody is left wondering why a
 * third row exists that nothing in this file created.
 *
 * ── The seeded password is deliberately below the sign-up floor ────────────
 *
 * `MIN_PASSWORD_LENGTH` in `app/lib/auth/password-rule.ts` is 10, and the
 * default seeded password, `password`, is 8 characters. `/sign-up` would
 * reject it outright. Sign-in never re-checks length, only the stored hash,
 * so these seeded accounts work anyway. This is NOT a bug to fix: `password`
 * at cost-10 bcrypt is the same convention selfhostedworld and lowcarbcheck
 * both seed, and matching it is the point of this change. Leave the mismatch
 * alone, and do not be surprised that typing `password` into `/sign-up`
 * itself is refused, that form is not how these two rows come to exist.
 *
 * ── Why `./db` is loaded with a dynamic import ─────────────────────────────
 *
 * ESM hoists every static `import` declaration above the statements in a
 * module body, so a static `import { closePool } from './db'` at the top of
 * this file would open the connection pool BEFORE the environment guard
 * below ever runs. The guard exists specifically to stop this script from
 * reaching a real server, so the pool must not open until the guard has
 * passed. `cli/index.ts` hits the identical ordering problem for a different
 * reason and solves it the same way: a dynamic `import()`, evaluated where it
 * is written rather than hoisted.
 */
import 'dotenv/config';

/** Hosts this script will write to. Anything else, including a Tailscale IP or a hostname, is refused. */
const ALLOWED_DEV_DB_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Refuses to run anywhere but a local development database.
 *
 * This script writes a known password (`password` by default) straight into
 * the `users` table. Pointing it at production or staging by accident, for
 * example a shell that inherited the wrong `.env`, would hand out a working
 * login with a published password. Both checks must pass, and this function
 * is the very first thing `main` calls, before any database module is even
 * loaded.
 */
function assertLocalDevelopment(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'drizzle/seed.ts refuses to run: NODE_ENV is "production". This script writes a known password into the database and must never touch a real server.',
    );
  }

  const dbHost = process.env.DB_HOST;
  if (dbHost === undefined || !ALLOWED_DEV_DB_HOSTS.has(dbHost)) {
    throw new Error(
      `drizzle/seed.ts refuses to run: DB_HOST is "${dbHost ?? '(unset)'}", not localhost or 127.0.0.1. This script writes a known password into the database and must never touch a real server.`,
    );
  }
}

/** The email of the stale single-account seed this script used to write. Deleted on every run, explicitly, see the file header. */
const STALE_SEED_EMAIL = 'dev@example.com';

/**
 * The two accounts this script seeds. Fixed addresses, not overridable: unlike
 * the single-account seed this replaces, two named, differently-privileged
 * accounts stop being useful the moment their addresses can drift, since a
 * test or a screenshot script would no longer know what to type.
 */
const SEED_ACCOUNTS: ReadonlyArray<{ email: string; isSuperadmin: boolean }> = [
  { email: 'superadmin@example.com', isSuperadmin: true },
  { email: 'user@example.com', isSuperadmin: false },
];

/** The password shared by both seeded accounts, printed back in full at the end. It is a local-only credential; hiding it would defeat the point. */
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'password';

/** The port the dev server listens on, for the sign-in URL this script prints. */
const SEED_PORT = process.env.PORT ?? '3000';

/**
 * bcryptjs work factor. Matches `BCRYPT_COST` in `app/services/auth.server.ts`
 * exactly, so a hash written here verifies the same way `signIn` verifies one
 * `registerUser` wrote. That module's own hashing is not reusable directly:
 * every exported function there does more than hash a password (mails a
 * confirmation link, leaves `emailVerifiedAt` unset, or both), and its cost
 * constant is not exported. Duplicating the literal is the smallest surface
 * that stays correct; if that constant ever moves, this one must move with
 * it. It also matches the cost the SHW and LCC seeds both use.
 */
const BCRYPT_COST = 10;

async function main(): Promise<void> {
  assertLocalDevelopment();

  const bcrypt = (await import('bcryptjs')).default;
  const { eq } = await import('drizzle-orm');
  const { normalizeEmail } = await import('#app/lib/auth/email');
  const { users } = await import('#drizzle/schema');
  const { getRawDb, closePool } = await import('./db');

  try {
    const db = getRawDb();
    const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_COST);
    const now = new Date();

    const staleEmail = normalizeEmail(STALE_SEED_EMAIL);
    const deletedStale = await db.delete(users).where(eq(users.email, staleEmail)).returning({ id: users.id });

    const results: Array<{ email: string; wasReset: boolean }> = [];

    for (const account of SEED_ACCOUNTS) {
      const email = normalizeEmail(account.email);
      const existing = await db.query.users.findFirst({ where: eq(users.email, email) });

      if (existing) {
        await db
          .update(users)
          .set({
            passwordHash,
            emailVerifiedAt: now,
            isSuperadmin: account.isSuperadmin,
            passwordChangedAt: now,
          })
          .where(eq(users.id, existing.id));
      } else {
        await db.insert(users).values({
          email,
          passwordHash,
          emailVerifiedAt: now,
          isSuperadmin: account.isSuperadmin,
        });
      }

      results.push({ email, wasReset: existing !== undefined });
    }

    if (deletedStale.length > 0) {
      console.log(`Deleted the stale single-account seed row: ${staleEmail}`);
    }

    console.log('Local development accounts:');
    for (const result of results) {
      console.log(`  ${result.wasReset ? 'reset' : 'created'}: ${result.email} / ${SEED_PASSWORD}`);
    }
    console.log(`  sign in: http://localhost:${SEED_PORT}/sign-in`);
    console.log('Dictionary rows are not seeded here. Restore them with scripts/dictionary-restore.sh.');
  } finally {
    await closePool();
  }
}

await main();
