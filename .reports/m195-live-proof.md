# M195 live proof, production

- Date: 2026-09-05, run window 10:20 to 10:35 CEST
- Build: `translate-prod` swapped to `da617b5f76d5` and answered `/healthcheck`
  200 on the second poll. `select to_regclass('public.phrase_translations')`
  answers `phrase_translations`, so the migration deployed.
- Account: `probe-m195@example.com`, created through `/sign-up`, verified with
  one SQL statement, deleted at the end (`DELETE 1`, count back to `0`).
- The case is the operator's own, verbatim: `Das auto volltanken`, German to
  Turkish.

## Steps

1. PASS The phrase translates on production. The pane read "Translating. This
   takes a moment.", then, with no reload, the Turkish sentence. The
   word-by-word echo the operator reported is gone.
2. PASS The second search is free. The answer rendered at once and
   `phrase_translations` still holds ONE row.
3. PASS The dictionary was not touched. Zero rows were added to `translations`
   in the ten minutes around the run. A sentence is not a lexical edge and this
   is the check that says so.
4. PASS The API is fenced. `POST /api/v1/translate` with no key answers `401`,
   and with a made-up key answers `401`.
5. PASS The API answers with a key, and its shape is the pane's own panel:
   `{"kind":"phrase","headwordId":null,"panel":{"state":"ready","translations":[
   {"lemma":"Arabayı fullemek","generated":true,...}]}}`.
6. PASS The CLI answers against production, both shapes, through one command.
   `pnpm cli --prod translate "Das auto volltanken" --from de --to tr` prints the
   sentence; `pnpm cli --prod translate "umwerfen" --from de --to tr` prints the
   seven Turkish words M193 generated. The header names the kind, `phrase` or
   `word`, and nothing else about the two answers differs.

## The generated sentence, verbatim

German `Das auto volltanken`, into Turkish:

> **Arabayı fullemek**

It is correct and colloquial: "fullemek" is the everyday Turkish verb for
filling a tank. The neutral register would be "arabanın deposunu doldurmak",
which is what a second run of the same prompt produced locally. Both are right.
The row is cached, so every later reader gets this one.

## Figures

- `phrase_translations`: one row, `Das auto volltanken` to `Arabayı fullemek`,
  status `ok`, cost `0.002213` USD.
- `daily_budget` for 2026-09-05: `0.070333` before, `0.072546` after, a move of
  exactly `0.002213`, which is the one run and nothing else.
- Rows added to `translations` by this run: `0`.

## Things worth knowing

- **Production had no API key at all** before this proof. `api_keys` was empty,
  so the whole `/api/v1/*` surface was unreachable from outside the browser. One
  key named `operator-cli` was minted inside the container with
  `pnpm cli api-key create` and written to `translate-altan-fyi/.env`, which is
  gitignored. Revoke it with `pnpm cli --prod api-key revoke <id>` if it is not
  wanted.
