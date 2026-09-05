# M195 browser walk, local instance

- Date: 2026-09-05
- Instance: `pnpm run dev` (web and worker) on `http://localhost:3210`, database
  `translate_altan_fyi`
- Account: `walk-m195@example.com`, created through `/sign-up`, verified with one
  SQL statement, deleted at the end (`DELETE 1`)
- The reported case, verbatim: `Das auto volltanken`, German to Turkish

## Steps

1. PASS The phrase translates. The pane read "Translating. This takes a moment.",
   then, with no reload, **Arabayı fullemek**, marked Generated. The word-by-word
   echo is gone. Below it, the per-word dictionary entries under their own line:
   "The dictionary entries for each word. The translation above is the whole
   sentence."
2. PASS The second search is free. `phrase_translations` held ONE row with
   status `ok` before it and one row after it. The answer rendered at once.
3. PASS A word is unchanged. `Baum`, de to en, still lists `boom` and `tree`
   with their vote controls and the dictionary entries below.
4. PASS A text over the cap is refused in plain words: "That text is too long to
   translate. Try 200 characters or less." Nothing was translated and no row was
   written.
5. PASS History carries the phrase with its answer:
   `Das auto volltanken → Arabayı fullemek | Deutsch to Türkçe`, one row.
6. PASS The CLI prints the same answer:
   `pnpm cli translate "Das auto volltanken" --from de --to tr` returns
   `Arabayı fullemek`, marked generated. `pnpm cli translate "Baum" --from de
   --to en` returns `boom` and `tree` through the same command and the same
   table. A word and a phrase differ only in the label the header prints.
7. PASS The two operator commands answer. `pnpm cli translation votes` reads
   "Nobody has voted a translation down." `pnpm cli translation runs --kind
   phrase` lists the run: `ok`, `google/gemini-3.8-flash`, cost `0.001722`.

## Figures

- One phrase run costs `0.001722` USD on `google/gemini-3.8-flash`.
- The phrase cache key is the normalized text with the pair. The second search
  and the CLI call both hit the same row.

## Things worth knowing

- The model answered the screen with `Arabayı fullemek` and an earlier CLI call
  with `Arabanın deposunu doldurmak`. Both are correct Turkish for filling a car
  up, the first colloquial and the second neutral. They differ because they were
  two runs of the same prompt, not because the two paths disagree: once a row is
  cached, every caller reads that one row, which is what step 6 shows.
- A stale dev server from the previous milestone held port 3210 and had to be
  killed by exact PID before this walk could run. Killing the toolbox wrapper
  does not kill the node process inside it.
