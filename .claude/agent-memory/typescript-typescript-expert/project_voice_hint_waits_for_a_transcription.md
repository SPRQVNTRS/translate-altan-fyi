---
name: voice-hint-waits-for-a-transcription
description: VoiceControl takes hasTranscript and holds voice.bestEffort back until words have been written into the box; VoiceInput owns the flag
metadata:
  type: project
---

`VoiceControl` in `app/components/voice-input.tsx` takes a required
`hasTranscript: boolean`. Its `<output>` line shows `voice.denied` /
`voice.failed` on error, `voice.listening` while listening, and
`voice.bestEffort` only when `hasTranscript` is true and it is not listening.
`VoiceInput` holds the flag in state and sets it from an `onTranscript` wrapper
around `createVoiceHandlers`.

**Why:** the note is advice about words a recogniser wrote. Rendered
unconditionally it was a second hint stacked under the input pane's own
`search.note` on a page nobody had touched yet.

**How to apply:** the flag must outlive the session. `state` returns to `idle`
when the recogniser ends while the words stay in the box, so deriving the note
from `state` alone would make it flash and vanish. `tests/unit/voice-input.test.ts`
has `renderControl(state, hasTranscript = false)`; a fresh idle control must NOT
carry the note. The Firefox path (`ServerVoiceControl`) was already conditional
and is untouched. Related: [[voice-input-takes-a-sink]].
