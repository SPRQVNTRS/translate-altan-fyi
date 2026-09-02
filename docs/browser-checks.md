# Browser checks

Manual, headed browser checks. A headless run is not a substitute here: hover
styles do not apply, scrollbars are hidden, and a microphone permission prompt
does not behave. Each entry records what was driven, in which browser, and what
was seen.

## M173/01 browser check

Date: 2026-09-02
Browser: Chrome 152 (headed, via agent-browser)
Target: the local production build (`pnpm build` then `pnpm start`) at
`http://localhost:3311/search`, viewport 390 x 844 and desktop.

Firefox is the browser with no Web Speech API, and it is not installed on this
workstation. The unsupported branch was therefore driven in Chrome with an init
script that deletes both constructors before the first navigation, which is the
same condition the code sees in Firefox:

```js
delete window.SpeechRecognition;
delete window.webkitSpeechRecognition;
```

What was seen:

1. **Supported browser.** The search card shows the spoken-language picker,
   defaulted to `Deutsch` from the detected search direction, and a
   `Start listening` button. The accessibility tree reports
   `combobox "Spoken language"` and `button "Start listening"`.
2. **First paint.** Before hydration the button reads `Checking browser support`
   and is disabled. That is the `checking` state, and it is deliberate: the
   feature check runs in an effect so the server and the first client render
   agree.
3. **Listening.** Clicking the button switches it to `Stop listening`, fills it
   in, swaps the icon, and the line below reads `Listening now`.
4. **Unsupported browser.** With both constructors deleted, the form contains
   exactly one button (`Search`) and the notice reads
   "This browser does not support speech recognition. A free server alternative
   is coming soon." No microphone button, no dead control.
5. **390 px.** The picker and the button sit on one row under the search field,
   with the note wrapping to two lines. Nothing overflows.

Not checked, and why:

- **Real dictation.** The workstation has no microphone, so no phrase was
  actually spoken. The path from a recognised phrase to the search box and the
  submitted form is covered by `tests/unit/voice-input.test.ts`, which drives
  the real session code with a stubbed recogniser.
- **Safari.** Not available on this workstation.

## M174/01 browser check

Date: 2026-09-02
Browser: Chrome 152 (headed, via agent-browser)
Target: the local production build (`pnpm build` then `pnpm start`) at
`http://localhost:3311`, viewport 390 x 844.

Headed, because a headless run cannot answer this one honestly: the card and
both verdict buttons carry `hover:` styles, and `(hover: hover)` is false in
headless Chrome, so those rules never apply there.

Setup, through the app's own screens rather than a seeded store: three German
words (Haus, Buch, Wasser) were searched, opened, and saved into a new list
called `M174 check` from each entry page. `/lists` then reported `3 words`.

What was seen:

1. **The link.** The list page shows `Review cards` above the words, and it
   opens `/lists/<id>/review`.
2. **The card.** The chrome renders the one `h1` (`Review flashcards`); the
   screen's own heading is an `h2` reading `Review M174 check`. The card shows
   `Haus`, the progress line reads `0 of 3`, and both verdict buttons are in the
   accessibility tree as `Still learning` and `Got it`.
3. **The flip, from the keyboard.** With the card focused, Space flipped it. The
   translation `house` appeared, the hint changed to `Tap the card to turn it
   back`, and `aria-pressed` on the card read `true`.
4. **Still learning brings the word back.** Pressing `Still learning` on `Haus`
   advanced to `Buch` and the live region read
   `Haus will return later in this session.` Two `Got it` presses later
   (`Buch`, then `Wasser`, progress `2 of 3`) the card was `Haus` again, inside
   the same session. The summary then read
   `You reviewed 3 cards. You marked 1 to see again.`
5. **Offline.** With the browser set offline, `Review again` started a fresh
   session and three `Still learning` presses were accepted with no error on the
   page and no network request. The screen never stalled between cards.
6. **The verdicts survived a reload.** After the reload, `reviewState` in the
   `translate-primary` IndexedDB database held one row per saved word, keyed by
   the list entry's id, each carrying its tally plus `lamport` and `deviceId`.
   The `Haus` row read `gotItCount 1, stillLearningCount 2` at `lamport 3`,
   which is the offline session added to the online one.

Screenshot: `/tmp/trl-review.png` (the flipped card at 390 wide).

One thing worth recording rather than fixing here: `Buch` was saved under a
meaning that has no translation yet, so its card back reads
`No translation yet for this word.` That is the entry's own state, shown by the
shared `search.noTranslationYet` string, not a review defect.

## M174/02 browser check

Date: 2026-09-03
Browser: Chrome 152 (headed, via agent-browser)
Target: the local production build (`pnpm build` then `pnpm start`) at
`http://localhost:3210/`, viewport 390 x 844.

Three words were saved through the real screens: `water`, `bread` and `book`,
each searched, opened, a meaning picked, and saved to a list named
`Nudge check`. A list review then answered every card `Still learning` once, so
all three carried `stillLearningCount 1` in the `reviewState` table of the
`translate-primary` IndexedDB database.

1. **Nothing on the server.** `curl` of `/` returns HTML with no
   `daily-nudge-title` and no nudge copy. The card exists only after hydration.
2. **Nothing before there is anything to offer.** On the very first visit, with
   no saved words, no card rendered and `nudgeShownOn` was not written. The
   marker is only written when a card is actually shown.
3. **Three real words.** On the home screen the card read `Daily review`,
   `Here are 3 saved words from your lists to review today.` and listed `book`,
   `water` and `bread` with their saved translations. Screenshot:
   `/tmp/trl-nudge.png`.
4. **The session holds exactly those three.** `Review words` opened
   `/review?entries=7bf4a638...,4536733f...,ef6573ff...`. The heading read
   `Reviewing 3 words`, the progress line `0 of 3`, and three `Got it` presses
   dealt `book`, `bread` and `water` and then the summary
   `You reviewed 3 cards.` No fourth card, and no word from outside the three.
5. **Once per local day.** Returning to `/` after the session, the card was
   gone. `nudgeShownOn` in the store's values read `2026-09-03`, the device's
   own local date, not the UTC one (the server logged the same moment as
   22:11 UTC on 2 September).
6. **Dismiss, then reload.** With `nudgeShownOn` set back to `2026-09-02` to
   stand in for the next day, the card returned. `Dismiss for today` removed it,
   and a reload did not bring it back. The stored date read `2026-09-03` again.

The next local day was simulated by writing `2026-09-02` into the
`nudgeShownOn` value in IndexedDB and reloading, because waiting for midnight is
not a check anybody would run. The day boundary itself is asserted in
`tests/unit/nudge-dismissal.test.ts` against dates rather than against a clock.

Two things worth recording rather than fixing here. `water` and `book` were
saved under meanings that have no translation yet, so the card lists them with
the shared `search.noTranslationYet` line, which is the entry's own state. And
the nudge renders on `/search` as well as on `/`, because both URLs are the same
route module; that is the index screen either way.
