---
name: translate-get-q-url-ceiling
description: The measured ceiling on the GET ?q= search param in translate-altan-fyi, and what enforces it
metadata:
  type: project
---

The `/search?q=` GET contract survives a multi-line `<textarea>`. Measured
against `pnpm dev` on 2026-09-03: 16000 ASCII characters answered 200, 17000
answered **431**. With non-ASCII text (Turkish `ş`) the boundary sat between
2700 (200) and 5000 (431).

**Why:** the limit is Node's `http.maxHeaderSize`, 16 KiB by default, covering
the whole request line plus every header. Percent-encoding costs 3 bytes per
UTF-8 byte, so a 2-byte character spends 6, and cookies eat the same budget.
Nothing in the app, Express or React Router imposes a shorter limit.

**How to apply:** do not switch the search to POST "because a textarea might be
long", and do not add a `maxLength` guard without a reason: a realistic
sentence or paragraph is one to two orders of magnitude below the ceiling. If a
surface ever needs to carry a whole document, that is the point to revisit,
and 431 is the symptom to expect.
Related: [[translate-altan-fyi-verify-commands]].
