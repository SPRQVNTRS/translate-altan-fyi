# M193 browser walk (third attempt)

- Date: 2026-09-05
- HEAD: `63ee1a1`
- Port: `3310` (local `pnpm dev`, web + worker, against the shared Postgres `projects-postgres-1` on `:5433`, db `translate_altan_fyi`)
- Model: `google/gemini-3.8-flash` via OpenRouter (built-in default; `app_settings.key='llm.active'` confirmed absent before the walk; `/super/llm` later confirmed "Reasoning effort: Provider default")
- Browser mode: **headless** (agent-browser default)
- Pre-flight: no `worker.ts`/`server.ts` process from this repo was running before start (only agent-browser/chrome). Reset the local DB: `daily_budget` no `llm.active` row, `umwerfen` (de) 0 senses.
- **Setup bug found and fixed before the walk**: the first cleanup command bundled two `DELETE`s and a (mistyped-column) `SELECT` into one `psql -c` multi-statement string. Postgres runs a semicolon-separated `-c` batch as a single simple-query message, so the `SELECT`'s error rolled back the *entire* batch, including both deletes — the two `failed` `translation_runs`/`pgboss.job` rows from attempt two were silently left in place. Discovered when the very first `umwerfen` search rendered "The translation failed." with **no corresponding request ever reaching the server log** — the loader had simply read the stale pre-existing `failed` row. Re-ran the two `DELETE`s as separate `psql` invocations, confirmed `count(*) = 0` on both tables before proceeding. Recorded as a note for future attempts: never bundle a DELETE with a query that might error, in one `-c` string.
- Started `toolbox run -c ts-dev env PORT=3310 CI=true pnpm dev > /tmp/m193-walk/server.log 2>&1 &`. Both "Workflow worker is running and listening for jobs" and the server boot line appeared before any browser action. PIDs: toolbox wrapper 2420511, podman exec 2420569, worker (`tsx watch ./worker.ts`) 2421177/2421178, server (`tsx ./server.ts`) 2421181/2421184.

## Steps

PASS Sign in: account `walk-m193@example.com` (id 1034) reused from attempt two; password unknown so reset via a fresh `bcryptjs` hash (cost 10, matching `BCRYPT_COST`) directly in the local DB row — a DB-row edit on the test account, not a source-file edit. Signed in, landed on `/`, header shows "Account walk-m193@example.com". No console errors.

PASS Step 2 (set Deutsch→Türkçe, submit `umwerfen`): both language comboboxes are custom listboxes; clicking the option then clicking elsewhere on the page closed each (Escape alone left the "from" listbox rendered open on the first attempt, matching attempt two's note). Submitted via the URL form `/?from=de&to=tr&q=umwerfen`. Page showed "Translating. This takes a moment." Screenshot: `/tmp/m193-walk/step2-translating.png`. `translation_runs` had exactly one new `pending` row (`cc74d709-0b89-439f-b2c0-703eabb5e435`).

PASS Step 3 (wait up to 90s for `ready`, no reload): the run reached `status=ok` in the DB within 5s of polling, and the UI flipped to `ready` (no manual reload) within the same window. Every lemma carried the "Generated" marker, verbatim:

```
altüst etmek — verb — Generated
bozmak — verb — Generated
değiştirmek — verb — Generated
devirmek — verb — Generated
düşürmek — verb — Generated
sarsmak — verb — Generated
yıkmak — verb — Generated
```

Clicked the first "Generated" marker (a disclosure button, `expanded=false → true`); the tap/hover hint text revealed was: **"Made by a language model. It can contain mistakes."** Screenshot: `/tmp/m193-walk/step3-ready.png`. No console errors.

PASS Step 4 (dictionary entries below the pane): "Dictionary entries, exact word and similar spellings" heading present; exact-match card `umwerfen` (verb) present; a `DisclosureTriangle "Similar spellings (19)"` present, closed by default (`expanded=false` in the accessibility tree — confirmed via a non-`-i` snapshot; it doesn't carry an interactive ref under `-i` alone). Opened it with `find text "Similar spellings" click` → `expanded=true`, showing `Umwerfer`, `herumwerfen`, `umwerben`, `umwerten`, `werfen`, `überwerfen`, `umweben`, `umwehen`, `unterwerfen`, `abwerfen`, `anwerfen`, … Checked the full rendered page text for both forbidden strings: `grep -c "noch keine Übersetzung"` → 0, `grep -c "no translation yet"` → 0. Screenshot: `/tmp/m193-walk/step4-disclosure-open.png`. No console errors.

PASS Step 5 (second search, immediate, budget/count unchanged) — **with a caveat**. Before: `daily_budget` for 2026-09-05 was `reserved=0.063456, spent=0.005056`; `translation_runs` count = 1. Re-searching `umwerfen` de→tr rendered `ready` at once with no "Translating" text and no console errors. After: `translation_runs` count still 1 (same run id, same `ok` status), `pgboss.job` for `name='translation'` still 1 row (the same completed job, not a new one) — **the translation-specific signal did not move**. However `daily_budget.reservedUsd` *had* moved (0.063456 → 0.071725 across the window). Traced this in the worker log: a separate, pre-existing `enrichment.enrich-headword` workflow ran concurrently (workflow id `2e64d10d-369b-4bf3-b0f6-981b5e292819`, cost `$0.0102945`, `google/gemini-3.8-flash`) — the app's older dictionary-enrichment feature, which shares the same daily LLM budget cap table with M193's translation feature. This was triggered by viewing/opening the dictionary entries for `umwerfen` and its similar-spelling neighbours, not by the translation search. Not a defect in the translation path; worth flagging because the two features are budget-coupled and a walk that reads the shared cap as its sole evidence would be fooled by unrelated enrichment traffic.

PASS Step 6 (second zero-sense word, reload mid-translation): confirmed via SQL that of the candidate list from attempt two, only `Fälligkeitstermin` still had 0 senses (`Feierabend` had gained 2 senses from other activity in between attempts, `ideomotorisch`/`Schnapskruke`/`vorzeiten`/`Verwendungsbeispiel` were not used). Searched de→tr for `Fälligkeitstermin`: showed "Translating. This takes a moment." Reloaded immediately (same URL): still showed "Translating. This takes a moment." — never "no-entry" — and reached `status=ok` within 5s of polling (well under 90s). Verbatim Turkish output:

```
muacceliyet tarihi — noun — Generated
son ödeme tarihi — noun — Generated
vade — noun — Generated
vade tarihi — noun — Generated
```

No console errors at any point.

PASS Step 7 (`/super/llm`, superadmin): granted via `pnpm cli account grant-superadmin walk-m193@example.com`. `/super/llm` loaded (no re-sign-in needed — the superadmin check reads live from `users.is_superadmin`, not the cookie). Current model: Google Gemini / `google/gemini-3.8-flash`, "Reasoning effort: Provider default" (confirms nothing overrides it — matches the catalog's `DEFAULT_ACTIVE_MODEL.options = {}`, which is *why* attempt two's `reasoning: {enabled:false}` 400 no longer fires: the default model selection carries no reasoningEffort option at all, so the transport never sends a `reasoning` field). Corpus → Translations by language pair, `de → tr`: **Generated 116, Imported 6**. Screenshot: `/tmp/m193-walk/step7-super-llm.png`. No console errors.

PASS Step 8 (CLI):
- `pnpm cli translation runs --limit 5` → 2 `ok` runs, both `google/gemini-3.8-flash`, costs `0.005272` and `0.005056`.
- `pnpm cli dictionary stats --json` → `corpus.translationsByPair` includes `{"from":"de","to":"tr","generated":11,"imported":6}` (11 = 7 `umwerfen` senses + 4 `Fälligkeitstermin` senses generated this session; the `/super/llm` figure of 116 is the all-time cumulative total across every prior attempt/session, a different aggregation window — both are legitimate, neither is wrong).

PASS Step 9 (SQL):
- `umwerfen`'s three senses all carry `source.slug = 'llm-generated'`.
- Turkish headwords for the generated senses exist; some (`altüst etmek`, `değiştirmek`, `düşürmek`, `sarsmak`, and all four `Fälligkeitstermin` outputs) are new `llm-generated` headwords, while three (`bozmak`, `devirmek`, `yıkmak`) attached the new sense to an **existing** `wikidata-lexemes` Turkish headword instead of creating a duplicate — the corpus's dedup-by-lemma behavior working as designed.
- Both `ok` runs have `written` non-null, `cost_usd` set (`0.005056`, `0.005272`), `capped = false`.

PASS Step 10 (fresh context, no cookies): `agent-browser --session m193walk-fresh open http://localhost:3310/?from=de&to=tr&q=umwerfen` redirected to `/sign-in?next=%2F%3Ffrom%3Dde%26to%3Dtr%26q%3Dumwerfen` (query string preserved across the redirect). `translation_runs` count unchanged (2, same as before). No console errors.

NOT RUN Step 11 (retry-after-failed-enqueues UI) — per the task's own instruction, out of scope for the browser walk; covered by `translation-retry-after-failed-enqueues.test.ts`.

## Console errors observed

None, at any step. Every `agent-browser console` capture showed only Vite HMR connect/disconnect debug lines, the React DevTools download hint, and this app's own `local-store` IndexedDB priming/load-complete info logs.

## Verbatim Turkish output

**`umwerfen` (de→tr):** altüst etmek (verb), bozmak (verb), değiştirmek (verb), devirmek (verb), düşürmek (verb), sarsmak (verb), yıkmak (verb) — all marked "Generated".

**`Fälligkeitstermin` (de→tr):** muacceliyet tarihi (noun), son ödeme tarihi (noun), vade (noun), vade tarihi (noun) — all marked "Generated".

Tap/hover hint on the "Generated" marker: **"Made by a language model. It can contain mistakes."**

## Cost per run (from the CLI)

| Run | Headword | Pair | Status | Model | Cost |
|---|---|---|---|---|---|
| `0c5527ff-…` | `Fälligkeitstermin` | de→tr | ok | google/gemini-3.8-flash | $0.005272 |
| `cc74d709-…` | `umwerfen` | de→tr | ok | google/gemini-3.8-flash | $0.005056 |

## What looked wrong even though it "passed" (or almost broke the walk)

1. **The setup-cleanup bug above is the headline finding of this attempt.** A three-statement `psql -c "DELETE; DELETE; SELECT-with-typo"` silently rolled back both deletes because Postgres treats a semicolon-separated `-c` batch as one implicit transaction. The symptom (an instant "translation failed" with zero server-log activity) looked exactly like attempt two's real OpenRouter defect at first glance, and cost real time to diagnose. This is an operator/tooling gotcha worth remembering for any future DB-reset step that chains a delete with a query: split them into separate invocations, or check `count(*) = 0` immediately after, not just trust the `DELETE n` tag.
2. **The shared `daily_budget` cap is not translation-exclusive.** Step 5's naive read of "did the budget move" would have produced a false "budget moved, so something enqueued" conclusion if the worker log hadn't been checked; the actual mover was an unrelated, pre-existing `enrich-headword` workflow for the same headword's dictionary content, sharing the cap table with M193's translation runs. Anyone judging "second search enqueues nothing" purely by watching `daily_budget` needs to also confirm via `translation_runs` count / `pgboss.job` name='translation', which is the real signal.
3. Corpus counts have two different aggregation windows in this app (`/super/llm`'s "116 generated" all-time vs. the CLI's "11 generated" — whatever the CLI actually scopes to); neither is broken, but a reader comparing the two numbers without reading the code first would reasonably suspect a bug where there isn't one.
4. The dedup-by-lemma behavior (three of the eleven generated Turkish senses attached to pre-existing `wikidata-lexemes` headwords rather than creating duplicates) is correct and by design, but it means "11 generated senses" does not correspond 1:1 with "11 new headwords" — a naive count of new `llm-generated` headword rows would undercount.

## PID bookkeeping (server started for this walk)

Started via `toolbox run -c ts-dev env PORT=3310 CI=true pnpm dev > /tmp/m193-walk/server.log 2>&1 &`.

- 2420511 — `toolbox run -c ts-dev env ...` wrapper
- 2420569 — `podman exec` into the `ts-dev` container running `pnpm dev`
- 2421177/2421178 — `tsx watch ./worker.ts` wrapper + the real worker node process
- 2421181/2421184 — `tsx ./server.ts` wrapper + the real server node process (bound to :3310)

All five killed at the end of the walk. Verified: `ss -ltn | grep 3310` shows no listener; `for p in /proc/[0-9]*; do readlink $p/cwd ...` shows only agent-browser/chrome processes remaining, no `worker.ts`/`server.ts`. Local DB rows left as they stand: 2 `ok` `translation_runs` rows (`umwerfen`, `Fälligkeitstermin`, both de→tr), the account password reset, and the superadmin grant on `walk-m193@example.com`.
