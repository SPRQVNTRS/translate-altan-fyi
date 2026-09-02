/**
 * E2E scenarios for the tenant-db wrapper.
 *
 * Connects to the dev DB, creates two throwaway orgs, exercises every method
 * on `tenantDb()` to confirm tenant isolation holds in practice — including
 * the round-1 counsel security fix (`update` must not let `organizationId`
 * through in the values payload).
 *
 * Usage: pnpm tsx scripts/e2e-tenant-db.ts
 * Exits non-zero on any failure. Always cleans up the test orgs/rows.
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { asTenantRows, getRawDb, tenantDb } from '#drizzle/tenant-db';
import { closePool } from '#drizzle/db';
import { articles, organizations } from '#drizzle/schema';

const SUITE = 'tenant-db E2E';
let failed = 0;
let testOrgAId: string | null = null;
let testOrgBId: string | null = null;

function ok(name: string): void {
  console.log(`  ✓ ${name}`);
}

function fail(name: string, detail: string): void {
  failed += 1;
  console.log(`  ✗ ${name}`);
  console.log(`      ${detail}`);
}

function section(name: string): void {
  console.log(`\n[${SUITE}] ${name}`);
}

async function setup(): Promise<{ orgA: string; orgB: string }> {
  const db = getRawDb();
  const suffix = `e2e-${Date.now()}`;
  const [a] = await db
    .insert(organizations)
    .values({ name: `Org A ${suffix}`, slug: `org-a-${suffix}` })
    .returning();
  const [b] = await db
    .insert(organizations)
    .values({ name: `Org B ${suffix}`, slug: `org-b-${suffix}` })
    .returning();
  if (!a || !b) throw new Error('Failed to create test orgs');
  testOrgAId = a.id;
  testOrgBId = b.id;
  console.log(`  Created test orgs A=${a.id} B=${b.id}`);
  return { orgA: a.id, orgB: b.id };
}

async function cleanup(): Promise<void> {
  const db = getRawDb();
  if (testOrgAId) {
    // Articles cascade-delete via the organizations FK.
    await db.delete(organizations).where(eq(organizations.id, testOrgAId));
  }
  if (testOrgBId) {
    await db.delete(organizations).where(eq(organizations.id, testOrgBId));
  }
  console.log(`\n  Cleaned up test orgs`);
}

async function scenario1_insertAutoStampsOrg(orgA: string, orgB: string): Promise<void> {
  section('Scenario 1: insert auto-stamps organizationId, never lets caller forge');
  const tdbA = tenantDb({ orgId: orgA });
  const tdbB = tenantDb({ orgId: orgB });

  const [rowA] = await tdbA
    .insert(articles, {
      title: 'A-only',
      slug: `a-only-${Date.now()}`,
      content: 'belongs to A',
    })
    .returning();
  const [rowB] = await tdbB
    .insert(articles, {
      title: 'B-only',
      slug: `b-only-${Date.now()}`,
      content: 'belongs to B',
    })
    .returning();

  if (!rowA || !rowB) {
    fail('insert returns rows', 'one of the inserts returned undefined');
    return;
  }
  if (rowA.organizationId !== orgA) {
    fail('rowA.organizationId === orgA', `got ${rowA.organizationId}`);
  } else {
    ok('rowA stamped with orgA');
  }
  if (rowB.organizationId !== orgB) {
    fail('rowB.organizationId === orgB', `got ${rowB.organizationId}`);
  } else {
    ok('rowB stamped with orgB');
  }
}

async function scenario2_selectFiltersByOrg(orgA: string, orgB: string): Promise<void> {
  section('Scenario 2: select returns only rows from the caller\'s tenant');
  const tdbA = tenantDb({ orgId: orgA });
  const tdbB = tenantDb({ orgId: orgB });

  const aRows = asTenantRows(articles, await tdbA.select(articles));
  const bRows = asTenantRows(articles, await tdbB.select(articles));

  const aHasOnlyOrgA = aRows.every((r) => r.organizationId === orgA);
  const bHasOnlyOrgB = bRows.every((r) => r.organizationId === orgB);

  if (!aHasOnlyOrgA) fail('A sees only orgA rows', `leaked: ${JSON.stringify(aRows.filter((r) => r.organizationId !== orgA))}`);
  else ok(`A sees ${aRows.length} row(s), all orgA`);
  if (!bHasOnlyOrgB) fail('B sees only orgB rows', `leaked: ${JSON.stringify(bRows.filter((r) => r.organizationId !== orgB))}`);
  else ok(`B sees ${bRows.length} row(s), all orgB`);
}

async function scenario3_updateAcrossTenantIsNoop(orgA: string, orgB: string): Promise<void> {
  section('Scenario 3: update with a where matching another tenant\'s row is a no-op');
  const tdbA = tenantDb({ orgId: orgA });
  const db = getRawDb();

  // Find orgB's article id.
  const [bArticle] = await db.select().from(articles).where(eq(articles.organizationId, orgB)).limit(1);
  if (!bArticle) {
    fail('precondition: orgB has at least one article', 'none found');
    return;
  }
  const originalTitle = bArticle.title;

  // Try to update orgB's row from orgA's tenantDb. The org filter should reduce this to a no-op.
  const updated = await tdbA.update(articles, eq(articles.id, bArticle.id), { title: 'PWNED' });
  void updated; // we check effect by re-reading

  const [bAfter] = await db.select().from(articles).where(eq(articles.id, bArticle.id)).limit(1);
  if (!bAfter) {
    fail('orgB row still exists', 'row vanished');
    return;
  }
  if (bAfter.title !== originalTitle) {
    fail('orgB row title unchanged', `was '${originalTitle}', now '${bAfter.title}'`);
  } else {
    ok('cross-tenant UPDATE was a no-op');
  }
}

async function scenario4_deleteAcrossTenantIsNoop(orgA: string, orgB: string): Promise<void> {
  section('Scenario 4: delete with a where matching another tenant\'s row is a no-op');
  const tdbA = tenantDb({ orgId: orgA });
  const db = getRawDb();

  const [bArticle] = await db.select().from(articles).where(eq(articles.organizationId, orgB)).limit(1);
  if (!bArticle) {
    fail('precondition: orgB has at least one article', 'none found');
    return;
  }

  await tdbA.delete(articles, eq(articles.id, bArticle.id));

  const [bStill] = await db.select().from(articles).where(eq(articles.id, bArticle.id)).limit(1);
  if (!bStill) {
    fail('orgB row still exists after cross-tenant delete attempt', 'row got deleted');
  } else {
    ok('cross-tenant DELETE was a no-op');
  }
}

async function scenario5_cannotMoveRowCrossTenantViaUpdateValues(orgA: string, orgB: string): Promise<void> {
  section('Scenario 5: caller cannot smuggle organizationId in the values payload (the round-1 fix)');
  const tdbA = tenantDb({ orgId: orgA });
  const db = getRawDb();

  // Find orgA's article id.
  const [aArticle] = await db.select().from(articles).where(eq(articles.organizationId, orgA)).limit(1);
  if (!aArticle) {
    fail('precondition: orgA has at least one article', 'none found');
    return;
  }

  // Simulate a sloppy caller who bypassed the type check and smuggled an
  // `organizationId` into the values payload. The wrapper's runtime strip is
  // what must protect against this — the assertion here is the test's whole point.
  // SAFETY: deliberately unsound. This value is exactly what the type system
  // forbids, constructed so the runtime guard can be exercised.
  const sloppyValues = { title: 'pwn-it', organizationId: orgB } as never;
  await tdbA.update(articles, eq(articles.id, aArticle.id), sloppyValues);

  const [aAfter] = await db.select().from(articles).where(eq(articles.id, aArticle.id)).limit(1);
  if (!aAfter) {
    fail('orgA row still exists', 'row vanished');
    return;
  }
  if (aAfter.organizationId !== orgA) {
    fail(
      'orgA row organizationId unchanged',
      `was ${orgA}, now ${aAfter.organizationId} — security regression: runtime strip failed`,
    );
  } else if (aAfter.title !== 'pwn-it') {
    fail('orgA row title was still updated', `expected 'pwn-it', got '${aAfter.title}'`);
  } else {
    ok('organizationId stripped from values; row stayed in orgA, title updated');
  }
}

async function scenario6_scopeComposesAndFilter(orgA: string): Promise<void> {
  section('Scenario 6: scope(table, extra) ANDs the org filter with extra conditions');
  const tdbA = tenantDb({ orgId: orgA });
  const db = getRawDb();

  // Insert two distinct slugs in orgA.
  const slug1 = `scope-${Date.now()}-1`;
  const slug2 = `scope-${Date.now()}-2`;
  await tdbA.insert(articles, { title: 'one', slug: slug1, content: 'c1' });
  await tdbA.insert(articles, { title: 'two', slug: slug2, content: 'c2' });

  // Use scope() with an extra filter via getRawDb().
  const rows = await db.select().from(articles).where(tdbA.scope(articles, eq(articles.slug, slug2)));

  if (rows.length !== 1) {
    fail('scope with extra filters to 1 row', `got ${rows.length}`);
  } else if (rows[0]!.slug !== slug2) {
    fail('scope returned wrong row', `got slug ${rows[0]!.slug}`);
  } else {
    ok('scope(table, extra) AND-ed correctly');
  }
}

async function main(): Promise<void> {
  console.log(`[${SUITE}] starting`);
  try {
    const { orgA, orgB } = await setup();
    await scenario1_insertAutoStampsOrg(orgA, orgB);
    await scenario2_selectFiltersByOrg(orgA, orgB);
    await scenario3_updateAcrossTenantIsNoop(orgA, orgB);
    await scenario4_deleteAcrossTenantIsNoop(orgA, orgB);
    await scenario5_cannotMoveRowCrossTenantViaUpdateValues(orgA, orgB);
    await scenario6_scopeComposesAndFilter(orgA);
  } finally {
    await cleanup();
    await closePool();
  }

  console.log('');
  if (failed === 0) {
    console.log(`[${SUITE}] ALL PASS`);
    process.exit(0);
  } else {
    console.log(`[${SUITE}] ${failed} FAILURE(S)`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(`[${SUITE}] ERROR:`, error);
  try {
    await cleanup();
  } catch {
    // ignore secondary cleanup failures
  }
  await closePool().catch(() => undefined);
  process.exit(1);
});
