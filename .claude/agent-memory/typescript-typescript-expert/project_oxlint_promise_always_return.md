---
name: oxlint-promise-always-return-in-useeffect
description: In translate-altan-fyi oxlint's promise(always-return) rejects the common useEffect .then(setState) idiom; the fix is an inner async function plus void
metadata:
  type: project
---

`pnpm lint` runs oxlint's `promise` plugin at error, and
`promise(always-return)` fires on ANY `.then()` callback that does not return a
value or throw. That kills the ordinary "read an async browser store on mount"
idiom:

```ts
useEffect(() => {
  hasAnyLocalData().then((found) => setHasData(found)).catch(() => setHasData(false));
}, []);   // <- promise(always-return), lint fails
```

The clean fix, no suppression:

```ts
useEffect(() => {
  const check = async (): Promise<void> => {
    try { setHasData(await hasAnyLocalData()); } catch { setHasData(false); }
  };
  void check();
}, []);
```

`void` on the call is the repo's existing idiom for a deliberately unawaited
promise (`app/components/enrichment-section.tsx`, `enrichment-votes.tsx`).

**Why:** two agents hit this same rule on the same day, in two unrelated
components, and both first-draft solutions were `.then()` chains.
**How to apply:** never write `.then(setState)` in a `useEffect` here; start
with the inner-async-function shape.

Related: [[oxlint-anti-slop-patterns]], [[translate-altan-fyi-verify-commands]]
