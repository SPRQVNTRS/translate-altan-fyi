---
name: llm-registry-owns-the-audio-call
description: @sprqvntrs/llm has no audio input, so the registry builds the OpenAI-shaped chat call itself and keeps the API key; callers use registry.transcribeAudio and tests inject withAudioPort
metadata:
  type: project
---

`app/lib/llm/registry.server.ts` carries a second seam beside `complete`:
`registry.transcribeAudio(active, request)` posts an `input_audio` content part
to the OpenAI-shaped `/chat/completions` of the active transport (OpenRouter or
OpenAI; the direct Anthropic transport raises `LlmCapabilityError`, its messages
API has no audio part). `registry.withAudioPort(port)` is the test seam, and it
must be restored to `null` in teardown.

**Why:** @sprqvntrs/llm 3.13.1 takes a prompt string and nothing else, so there
was no library path for a recording. The rule that the registry is the only
place a provider, a model or a key is read still had to hold, so the raw call
was built there rather than in the route or the service. `readApiKey` stays
private and the key never leaves the file.

**How to apply:** any future non-text modality goes in the same place and gets
its own port plus its own `withXPort`. A caller that constructs a vendor client
or reads `OPENROUTER_API_KEY` outside this file is the thing this shape exists
to prevent. The `fetch` carries an explicit `AbortSignal.timeout` because of
undici's hidden 300 s cap.
