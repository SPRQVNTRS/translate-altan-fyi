---
name: root-clientloader-absorbs-offline-revalidation
description: root's clientLoader is what keeps every client-only mutation alive offline; deleting it reintroduces a whole-page crash after a successful local write
metadata:
  type: project
---

`app/root.tsx` exports a `clientLoader` that calls `serverLoader()` and, on a
network failure only, answers with remembered or first-run root data.

**Why:** every client-only mutation (`clientAction` + `useFetcher` on lists,
history, notes) triggers a React Router revalidation. Root has a SERVER
`loader`, so that revalidation fetches `/<path>.data`. `public/sw.js` refuses to
cache `.data` by design (a cached loader response would be a stale translation
presented as live), so offline the fetch rejects with a `TypeError` and the root
error boundary killed a page whose write had already landed in IndexedDB.

**How to apply:**
- The classification is `shouldFallbackOffline` from `#app/lib/local-store`.
  Never write a second inline check. It absorbs an offline navigator or a
  `TypeError` and lets everything else through, so root's trailing-slash thrown
  `redirect` and any 5xx still reach the boundary.
- Do NOT set `clientLoader.hydrate`. The default reuses SSR root data on
  hydration; setting it adds a fetch to every cold load.
- The first-run offline answer is `user: null`, `toast: null`, language from
  `readLanguageCookie() ?? readStoredLanguage() ?? DEFAULT_LANGUAGE`.

Related: [[root-data-headers-serialized]]
