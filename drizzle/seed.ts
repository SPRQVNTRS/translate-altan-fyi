/**
 * The seed, which now seeds nothing.
 *
 * IT IS A NO-OP ON PURPOSE, and the file survives so the `db:seed` script and
 * anybody's muscle memory keep working while saying so out loud.
 *
 * The starter base seeded a default organization, five users and a sample page.
 * All three tables went with the org scaffolding in M189. What is left cannot
 * be seeded, and that is a property of the product rather than an omission:
 *
 *   - a USER signs themselves up and confirms an address by clicking a mailed
 *     link, so a seeded row would be an account nobody can prove they own;
 *   - the DICTIONARY is imported, not invented, by `pnpm cli import ...`.
 */
import { closePool } from './db';

async function main(): Promise<void> {
  console.log('Nothing to seed.');
  console.log('  users:      created at /sign-up, never by this script');
  console.log('  dictionary: pnpm cli import wikidata-lexemes | tatoeba');
  await closePool();
}

await main();
