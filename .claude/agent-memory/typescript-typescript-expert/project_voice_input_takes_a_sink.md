---
name: translate-voice-input-takes-a-sink
description: VoiceInput's inputRef is a TranscriptSink, not an HTMLInputElement, because the search box is a textarea
metadata:
  type: project
---

`VoiceInput` / `ServerVoiceFallback` (`app/components/voice-input.tsx`) take
`inputRef: RefObject<TranscriptSink | null>`, where `TranscriptSink` is
`{ value: string }`. It was `RefObject<HTMLInputElement | null>` until M185/01
made the search box a `<textarea>`.

**Why:** writing `.value` is the only thing the component ever does with that
ref, so the DOM type was a false constraint that a textarea ref could not
satisfy. There is still exactly ONE query path for speech: the recogniser
writes the box and calls `requestSubmit()` on the same form a typist submits.

**How to apply:** do not narrow it back to a DOM element type. If a screen
needs the voice control, hand it any ref whose `current` has a `value`, plus a
real `RefObject<HTMLFormElement | null>`.
`tests/unit/voice-input-textarea-submit.test.ts` pins both halves: the type
assignment is the compile-time assertion, and the run-time cases drive the
shipped `startVoiceSession` / `createVoiceHandlers` / `deliverTranscript`
against a textarea-shaped sink.
