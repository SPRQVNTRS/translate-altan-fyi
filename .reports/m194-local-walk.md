# M194 browser walk, local instance

- Date: 2026-09-05
- Instance: `pnpm run dev:server` on `http://localhost:3210`, database
  `translate_altan_fyi` in the shared Postgres on port 5433
- Account: `walk-m194@example.com`, created through `/sign-up`, verified with one
  SQL statement, deleted at the end (`DELETE 1`, `translation_votes` back to 0)
- Word: German `Baum`, into English. It carries two served translations, `boom`
  and `tree`, so no model call was needed for this walk.

## Steps

1. PASS Search `Baum`, de to en, signed in. The answer card carries a star
   ("Save this word") and every translation row carries the two vote buttons.
   Clicking the star flips its label to "Remove this saved word" with
   `aria-pressed=true`.
2. PASS `/favourites` lists one row, reading `Baum → boom, tree` over
   `Deutsch to English`, with a "Remove" control.
3. PASS The row's link is `/translate?q=Baum&from=de&to=en` and re-runs the
   search: the answer card comes back with the same two words.
4. PASS Un-starring from the answer card empties `/favourites`, which then shows
   "No saved words yet".
5. PASS History does not repeat itself. Searched `Hund`, `Katze`, `Baum`,
   `Baum`, `Baum`, `Wasser`, `Baum`, and `Baum` once more before that.
   `/history` lists FOUR rows, `Baum` once and at the top:
   `Baum → boom, tree` / `Deutsch to English` / 2 seconds ago, then `Wasser →
   water`, `Katze → cat`, `Hund → dog`. Every row reads term, answer and pair.
6. PASS Voting. Down-voted `tree`: the row read `0 1` at once and
   `translation_votes` held one row with `value = -1`. Reloading the search kept
   the count and kept the down button pressed. Then up-voted the same word: the
   row read `1 0` and the table still held ONE row, now `value = 1`. One vote per
   reader, changeable, counted once.
7. PASS The operator's view. `/super/llm` gained a "Down-voted translations"
   block. With the vote standing at up it reads "No down-voted translations";
   after a down-vote it lists `tree | de to en | 0 | 1 | 9/5/2026, 9:04:33 AM`.
8. PASS Signed out, the answer surface renders no star at all (zero buttons
   labelled "Save this word").

## Things that looked wrong even though the step passed

- A signed-out visitor still gets an empty `translate-primary` IndexedDB
  database opened by the landing page. Deleting both databases and reloading `/`
  signed out re-creates them. This is NOT from this milestone: production, which
  runs the pre-M194 build, does exactly the same on its own origin. It is worth
  its own look, because the same class of defect was fixed once on 2026-09-04 for
  the daily nudge.
- The copy button on the answer card renders disabled in this headless browser,
  because `navigator.clipboard` is undefined there. It is not a regression: the
  condition is `text !== '' && navigator.clipboard !== undefined`, and the answer
  text was present and correct.
