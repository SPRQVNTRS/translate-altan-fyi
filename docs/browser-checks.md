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
