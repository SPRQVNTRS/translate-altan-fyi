/**
 * The prompt version stored on every enrichment row. Bump it when `v<n>.md`
 * changes meaning.
 *
 * WHY THIS IS ITS OWN MODULE
 *   `index.ts` beside it reads `v1.md` from disk with `readFileSync` at module
 *   load. A route loader needs the version number to build a cache key, and
 *   nothing else, so importing it from `index.ts` would pull a synchronous file
 *   read, and `node:fs`, into the React Router server build for the sake of one
 *   integer. This file has no imports at all, so a loader can take the number
 *   and leave the file system behind.
 */
export const PROMPT_VERSION = 1;
