---
name: toast-after-client-action-not-in-render
description: Raising a sonner toast from a fetcher result must happen in an effect, guarded per answer; a render-phase call warns and `t` in the deps re-fires it
metadata:
  type: project
---

A success toast tied to a `clientAction` result belongs in a `useEffect`, never in
the render body, and it needs a `useRef` holding the last answer already
confirmed.

**Why:** two separate traps.
1. `toast()` publishes to sonner's observer, which setStates the `Toaster`. Called
   during another component's render (the shape `confirm-action.tsx` used for
   `setOpen` / `onSuccess`) React warns "cannot update a component while
   rendering a different component". `setOpen` alone was legal because it is a
   same-component render-phase update.
2. oxlint runs `react-hooks(exhaustive-deps)` at error, so `t` from
   `useTranslation` MUST be in the deps. `t` gets a new identity on a language
   change, which re-runs the effect over the same `fetcher.data` and toasts a
   second time.

**How to apply:** the working shape is

```tsx
const confirmed = useRef<object | null>(null);
useEffect(() => {
  if (fetcher.data?.success !== true || confirmed.current === fetcher.data) return;
  confirmed.current = fetcher.data;
  toast.success(t('...'));
}, [fetcher.data, t]);
```

`fetcher.data` is a fresh object per submission, so identity is the right key.
For an interpolated value the action does not return (a list name), capture it in
a second ref from the form's `onSubmit`: reading the field at confirmation time
names whatever is in it now. AGENTS.md bans suppression comments, so
`eslint-disable-next-line react-hooks/exhaustive-deps` is not an option.
Related: [[project_oxlint_anti_slop_patterns]].
