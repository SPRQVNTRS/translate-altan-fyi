/**
 * The prompt version stored on every phrase row. Bump it when `v<n>.md` changes
 * meaning.
 *
 * WHY THIS IS ITS OWN MODULE
 *   `index.ts` beside it reads `v1.md` from disk. A route loader needs the
 *   version number to build the job payload and the singleton key, and nothing
 *   else, so importing it from `index.ts` would pull a synchronous file read,
 *   and `node:fs`, into the React Router server build for the sake of one
 *   integer. This file has no imports at all, so a loader can take the number
 *   and leave the file system behind.
 *
 * IT IS ALSO PART OF THE DEDUPE KEY. Bumping it is how a reworded prompt gets a
 * second chance at a sentence an earlier version already answered.
 */
export const PHRASE_PROMPT_VERSION = 1;
