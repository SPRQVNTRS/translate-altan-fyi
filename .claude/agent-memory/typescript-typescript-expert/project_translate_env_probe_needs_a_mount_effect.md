---
name: project-translate-env-probe-needs-a-mount-effect
description: An SSR render that reads globalThis.navigator ships a disabled control React never repairs; probe the browser environment in a one-shot mount effect
metadata:
  type: project
---

Reading a browser global during render in an SSR'd component silently ships the
SERVER's answer to the client. `CopyButton` in
`app/components/search-panes.tsx` computed
`globalThis.navigator?.clipboard !== undefined` during render, so the server
always emitted `disabled=""`, the first client render said `disabled={false}`,
and React logged the hydration mismatch and LEFT THE SERVER ATTRIBUTE IN THE
DOM. React does not repair a mismatched attribute without a later re-render, so
both copy buttons were dead on first paint and only worked after an unrelated
click.

**Why:** a browser walk of `/?q=umwerfen&from=de&to=tr` measured
`disabled === true` on first paint and `false` after any re-render. Typecheck,
oxlint and 805 unit tests were all green throughout, so no gate in this repo
catches it.

**How to apply:** hold the probe in state seeded to the SERVER's value and set
it in a `useEffect(..., [])`. This is not the repo's "avoid useEffect for
derived state" violation, and the comment must say so: it is an environment
read that cannot run during server rendering, not state derived from props.
Keep the guard, `navigator.clipboard` really is undefined on an insecure
origin. Related: [[project_translate_primary_answer_and_alternatives]].
