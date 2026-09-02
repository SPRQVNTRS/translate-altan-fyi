---
name: api-v1-bearer-guard-exemptions
description: An Express guard 401s every /api/v1/* path with no bearer header before the router runs; a new public route needs an exemption, and route-level tests cannot catch the gap
metadata:
  type: project
---

`app/lib/api-middleware.server.ts` runs in `server.ts` ahead of the React Router
handler and answers `401` to any `/api/v1/*` request whose `Authorization`
header is not `Bearer <token>`. Two exemption lists let a path through:
`SESSION_AUTH_PREFIXES` (`/api/v1/auth/`, `/api/v1/sync/`) and
`CREDENTIAL_FREE_PREFIXES` (`/api/v1/transcribe`). The policy is the pure
`requiresBearerToken(path)`, which is what a unit test drives.

**Why:** M173/02 added `/api/v1/transcribe`, a public POST whose caller is a
browser with no credential. Every unit and integration test was green, because
they import the route's `action` and call it directly, so nothing in the repo
passes through Express. A curl against stage returned the guard's 401 and
nothing else. The whole feature was dead for exactly the browsers it exists to
serve.

**How to apply:** adding any route under `/api/v1/` that a browser or an
anonymous caller must reach means editing that exemption list in the same
change, and pinning it with a `requiresBearerToken` case. A route-level test
proves nothing about this layer. Reach for a real HTTP request against stage
before calling such a route done. See [[project_verify_commands]].
