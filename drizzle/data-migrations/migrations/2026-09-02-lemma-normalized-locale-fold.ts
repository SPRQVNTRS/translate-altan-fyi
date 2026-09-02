import { sql } from 'drizzle-orm';
import type { DataMigrationDb } from '../runner';
import { normalizeForLanguage } from '#app/lib/dictionary/normalize';

/**
 * Re-normalise every `headwords.lemma_normalized` with the row's own language.
 *
 * WHY THIS EXISTS
 *   M173/04 made the fold language-aware. Two languages now store a different
 *   key than they did before: Turkish, where all four i letters collapse onto
 *   `i` (`ışık` was stored as `ısık` and is now `isik`), and German, where `ß`
 *   folds to `ss` (`Straße` was `straße` and is now `strasse`).
 *
 *   `headwords.lemma_normalized` is compared with a plain `=`. Shipping the new
 *   fold without rewriting the stored side would leave the table holding keys
 *   the query form can no longer produce, and nothing would raise: the affected
 *   words would just stop being found. So the code change and this rewrite are
 *   one deploy.
 *
 * WHY IT REWRITES EVERY ROW, NOT ONLY THE TURKISH AND GERMAN ONES
 *   A filter on "rows that look affected" is a second implementation of the
 *   fold, written in SQL, which is precisely the drift this milestone exists to
 *   remove. The recomputation is the only authority on whether a row changed,
 *   so every row is recomputed and only the ones that actually differ are
 *   written.
 *
 * IDEMPOTENT
 *   `normalizeForLanguage` is a fixed point of itself, so a second run finds
 *   nothing to change and writes nothing. The runner also records the name in
 *   `data_migrations` and will not call this again in the same environment; the
 *   idempotence is the belt to that brace, and it is what makes it safe to run
 *   by hand against a database restored from a dump.
 *
 * BATCHED, KEYED ON THE ID
 *   The rows are read in `id` order in pages, and each page's updates go in ONE
 *   statement through `unnest`. A per-row `UPDATE` would be one round trip per
 *   headword, and the table holds hundreds of thousands. The whole thing runs
 *   inside the transaction the runner opened, so a failure anywhere leaves the
 *   column exactly as it was.
 */

/** Rows read per page. Large enough to amortise the round trip, small enough to hold. */
const PAGE_SIZE = 5000;

type HeadwordRow = {
  id: string;
  lemma: string;
  language_code: string;
};

export default async function (db: DataMigrationDb): Promise<void> {
  // A keyset cursor on `id`, not an OFFSET. OFFSET re-scans and discards every
  // row it already skipped, so paging a table this size with it costs quadratic
  // work. `null` means "before the first row" and drops the predicate entirely.
  let cursor: string | null = null;
  let read = 0;
  let changed = 0;

  for (;;) {
    // Annotated rather than inferred: `cursor` is assigned from this result at
    // the end of the loop, and without the annotation TypeScript sees the page
    // type as depending on itself.
    const rows: HeadwordRow[] = (
      await db.execute<HeadwordRow>(
        cursor === null
          ? sql`select id, lemma, language_code from headwords order by id limit ${PAGE_SIZE}`
          : sql`select id, lemma, language_code from headwords where id > ${cursor}::uuid order by id limit ${PAGE_SIZE}`,
      )
    ).rows;
    if (rows.length === 0) break;

    const ids: string[] = [];
    const normalized: string[] = [];

    for (const row of rows) {
      read += 1;
      // No fallback language. A row whose language has no fold rules would be
      // stored under a key produced by another language's rules, and nothing
      // downstream could tell. The `languages` table only holds the four served
      // codes, so this throw is unreachable rather than tolerated.
      const next = normalizeForLanguage(row.lemma, row.language_code);
      ids.push(row.id);
      normalized.push(next);
    }

    // Only the rows that really differ are written. The comparison happens in
    // SQL against the stored value, so the statement is one round trip and the
    // reported count is rows CHANGED, not rows offered.
    const updated = await db.execute<{ id: string }>(sql`
      update headwords as h
      set lemma_normalized = v.normalized
      from (
        select
          unnest(${sql.param(ids)}::uuid[]) as id,
          unnest(${sql.param(normalized)}::text[]) as normalized
      ) as v
      where h.id = v.id and h.lemma_normalized is distinct from v.normalized
      returning h.id
    `);
    changed += updated.rows.length;

    const last: HeadwordRow | undefined = rows.at(-1);
    if (last === undefined) break;
    cursor = last.id;

    if (rows.length < PAGE_SIZE) break;
  }

  console.log(
    `[2026-09-02-lemma-normalized-locale-fold] read ${read} headwords, rewrote ${changed}`,
  );
}
