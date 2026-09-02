---
name: e2ee-copied-not-extracted
description: app/lib/e2ee is a verbatim copy from two repos; protocol.ts is the SERVICE half and stays the single transcription, so client code that needs the CLIENT half gets trimmed
metadata:
  type: project
---

`app/lib/e2ee/**` is a verbatim copy (ADR-0008, COPY-NOT-EXTRACT) from two
sources: the root and account/server files come from `openplate-sync`
(`src/lib/*`, `src/protocol.ts`, `src/accounts/*`, `src/server/*`), the
`crypto/`, `client/` and `flows/` files from `openplate`
(`app/lib/sync/engine/*`, `app/lib/sync/*`). Every file carries a
`COPIED, NOT SHARED` header naming its source path and commit.

`protocol.ts` is the SERVICE half. The two upstream halves are hand-maintained
duplicates with DIFFERENT export surfaces:
- `readHandshakeNotice` exists only in the client half
- `isProtocolHandshake` returns `boolean` here, `value is ProtocolHandshake` there
- `KdfDescriptor` lives in `protocol.ts` there, in `kdf-descriptor.ts` here (same shape)
- `JsonValue`/`JsonObject` are re-exported there, imported from `./json` here

**Decision (2026-09-02):** keep ONE protocol.ts, the service half, and trim the
client instead. `auth-client.ts`'s `handshake()`, `signupMode()` and `notice()`
were removed for this reason: all three probe `/health` on an ARBITRARY remote
sync server, a self-hosting affordance, and here the server is the same origin
and same build.

**Why:** the server modules import this same file, and a second protocol
transcription inside one repo is the exact drift ADR-0008 bounds, self-inflicted
rather than inherited.

**How to apply:** before editing under `app/lib/e2ee/client/`, check which
protocol half a symbol belongs to. Never widen `protocol.ts` to suit a client
caller; restoring a trimmed client method means copying openplate's client-side
protocol half. Domain-separation labels (`openplate-sync:verifier-pepper:v1`
etc.) and the HKDF info labels are FROZEN and must stay byte-identical, or the
wire contract and the transcription test in `tests/unit/e2ee/protocol.test.ts`
break. See [[verify-commands]].
