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
 *   - an ACCOUNT is minted by the browser at signup, from a passphrase this
 *     repo must never hold, so there is no row a seed could write;
 *   - the DICTIONARY is imported, not invented, by `pnpm cli import ...`;
 *   - an INVITE is minted by `pnpm cli account invite`, once, and its token is
 *     printed once.
 */
import { closePool } from './db';

async function main(): Promise<void> {
  console.log('Nothing to seed.');
  console.log('  accounts:   created by a browser at signup, never by this script');
  console.log('  dictionary: pnpm cli import wikidata-lexemes | tatoeba');
  console.log('  invites:    pnpm cli account invite');
  await closePool();
}

await main();
