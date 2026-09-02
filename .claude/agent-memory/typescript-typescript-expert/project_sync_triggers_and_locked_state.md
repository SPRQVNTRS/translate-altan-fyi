---
name: sync-triggers-and-locked-state
description: In translate-altan-fyi the outbox carries WRITES only, so sync triggers must run a cycle; and a signed-in device with no DEK is a third UI state the vault announces
metadata:
  type: project
---

Two facts about `app/lib/sync/` that a reader keeps rediscovering the hard way.

**1. The outbox is a push queue, so a flush is not a pull.** `flushOutboxOnce`
selects from queued records; a device that has never made a local edit has an
empty outbox and therefore never runs a cycle. Wiring boot/`focus`/`online` to a
flush alone left every SECOND device permanently empty. Those triggers now
flush (so parked write intents keep their order and backoff) and then call
`runSyncCycleForCurrentSession` directly. That is safe without a new lock:
`flushOutboxOnce` is single-flight and `runSyncCycle` takes
`withSyncOrchestratorLock`, which WAITS rather than skips.

**2. A signed-in device can hold no data key, and that is not an error.** The
cookie is httpOnly and long lived; the DEK is a module variable in
`sync-session.ts` that a reload destroys. So `/settings` has three states, not
two, and the loader can only answer the first: `isSignedIn` is server truth,
`getSyncSession() !== null` is browser truth. `settings.tsx`'s loader now also
returns `handle` (the account's own identifier, to its owner, never rendered)
because the unlock card needs it to re-derive.

`setSyncSession` notifies ONE listener slot (`setSyncSessionListener`, the
scheduler installs it). That is the only place setup, sign-in and unlock all
converge, so a post-session catch-up cycle is written once instead of three
times.

**How to apply:** never add a fourth serialization mechanism to sync, and never
treat the locked state as an error state in UI. Related:
[[translate-altan-fyi-verify-commands]], [[the-local-store-barrel-is-the-one-seam]].
