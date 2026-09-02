/**
 * The source register behind the attribution page.
 *
 * THIS IS THE ONE READ THAT IS DELIBERATELY NOT LICENCE-FILTERED.
 *   Every other query in `app/lib/dictionary/` constrains `sources.licence` to
 *   `SERVED_LICENCES` inside the statement, because those queries return
 *   CONTENT: lemmas, glosses, translations, sentences. A row whose licence is
 *   not on the allowlist may be stored and counted, and it may never reach a
 *   reader.
 *
 *   This query returns no content. It returns the register of what was
 *   imported and under which terms, which is the attribution page's entire job.
 *   Hiding the share-alike and copyleft sources here would defeat that page: it
 *   would state that the dictionary was built from four permissive datasets
 *   while several more sit in the database, imported and used for internal
 *   comparison. Disclosure is the opposite of serving, so the filter that
 *   protects the content path would be a misstatement on this one.
 *
 *   The distinction to hold on to: this lists SOURCES, never their ROWS. No
 *   caller may join content onto this result and publish it. Content comes from
 *   the licence-filtered queries, and only from those.
 *
 * THE DATABASE IS STILL A PARAMETER, NEVER AN IMPORT. `drizzle/db.ts` opens a
 * pool at module load, so only the TYPE is imported here.
 */

import { asc } from 'drizzle-orm';
import { sources } from '#drizzle/schema';
import type { DictionaryDb } from './queries.server';

/** One imported dataset, as the attribution page discloses it. */
export interface SourceRow {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  licence: string;
  attribution: string;
  importedAt: Date | null;
  version: string | null;
}

/**
 * Every source row, ordered by name.
 *
 * @param db The dictionary database handle.
 * @returns All sources, including those whose licence is not served.
 */
export async function listSources(db: DictionaryDb): Promise<SourceRow[]> {
  return db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      url: sources.url,
      licence: sources.licence,
      attribution: sources.attribution,
      importedAt: sources.importedAt,
      version: sources.version,
    })
    .from(sources)
    .orderBy(asc(sources.name));
}
