# M194 live proof, production

- Date: 2026-09-05, run window 09:12 to 09:20 CEST
- Build: `translate-prod` swapped at 07:09 UTC and answered `/healthcheck` 200
  on the third poll. Both containers, stage `translate` and production
  `translate-prod`, run the one image the push built.
- Account: `probe-m194@example.com`, created through `/sign-up`, verified with
  one SQL statement, deleted at the end.
- Executed by an unattended agent on the operator's own instruction.

## Steps

1. PASS The migration is on production. `select to_regclass('public.translation_votes')`
   answers `translation_votes`, so the table the deploy carried is there.
2. PASS Signed in, searched German to Turkish for `umwerfen`. The answer card
   listed the seven generated Turkish words, each with a "Generated" marker and
   a `0 0` score beside it. No new translation run was created for it: the
   corpus answered from the rows M193 wrote.
3. PASS Starred the answer. `/favourites` lists one row, reading
   `umwerfen → afallatmak, altüst etmek, bozmak, değiştirmek, devirmek,
   sarsmak, yıkmak` over `Deutsch to Türkçe`.
4. PASS Up-voted `afallatmak`. The row read `1 0` at once, and
   `translation_votes` held exactly ONE row, `value = 1`, joined to a
   translation whose source is `llm-generated`. That is the shape the feature
   was built for: a reader judging a word a model wrote.
5. PASS History does not repeat. Searched `Hund` de to tr, then opened
   `/history`: two rows, `Hund` alone with its pair, and `umwerfen` with its
   full answer and pair. `Hund` has no translation into Turkish yet, so the row
   shows the term alone rather than an empty arrow, which is the null case the
   milestone designed for.
6. PASS Cleaned up. `DELETE FROM users WHERE email='probe-m194@example.com'`
   answered `DELETE 1`; the user count for `probe-m194%` reads `0` and
   `translation_votes` reads `0`, because a vote cascades with the account that
   cast it. That cascade is the erasure path, and it is why this report carries
   the figure rather than the table.

## Figures

- `translation_runs` on production: 3. The third is the `Hund` de to tr run that
  step 5's search queued, which is ordinary product behaviour and not a defect:
  a word with no answer in the target language is exactly what M193 built the
  job for.
- `daily_budget` for 2026-09-05: `spent_usd = 0.024360`, against the `3.0` cap.
- `translation_votes` during step 4: one row, `value = 1`, on an
  `llm-generated` edge. After the probe was deleted: 0.

## Things that looked wrong even though the step passed

- The GitHub webhook posts to `/webhook/translate`, the STAGE service, and the
  production trigger `translate-prod` was never touched by this push. Production
  still deployed, because one build serves both containers from one image tag.
  So `bay-build@translate-prod` is a unit that a push never fires, and anybody
  reading the trigger directory to check whether production deployed will read
  it wrong.
