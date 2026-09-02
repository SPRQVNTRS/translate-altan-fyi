---
name: root-data-headers-serialized
description: root's loader returns a live Headers, but the client type is an all-undefined method bag, so a clientLoader fallback cannot hand back combineHeaders()
metadata:
  type: project
---

`app/root.tsx`'s server `loader` returns `headers: combineHeaders(...)`, a real
`Headers`. The CLIENT type, `Awaited<ReturnType<Route.ClientLoaderArgs['serverLoader']>>`,
is NOT `Headers`: single fetch cannot serialize methods, so the field types as
`{ append: undefined; delete: undefined; get: undefined; getSetCookie: undefined;
has: undefined; set: undefined; forEach: undefined; [Symbol.iterator]: undefined;
entries: undefined; keys: undefined; values: undefined }`.

**Why:** a `clientLoader` offline fallback must produce a value of the CLIENT
type. `combineHeaders()` fails with TS2322 ("Type 'Headers' is not assignable"),
and `{}` fails too because the props are required, not optional.

**How to apply:** spell out the literal with every method key set to `undefined`
and pin it with `satisfies RootData['headers']`. That is runtime-identical to
what turbo-stream actually delivers and needs no `as` assertion, so it clears
`require-safety-comment-for-type-assertion`. The constant is
`NO_SERIALIZED_HEADERS` in `app/root.tsx`.

Related: [[root-clientloader-absorbs-offline-revalidation]]
