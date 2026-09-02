# 0004 — The custom `server.ts` is the production entrypoint

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** SPRQVNTRS

## Context

The stack ships a custom Express entry (`server.ts`) that wires up compression, the API JSON gate (`apiJsonMiddleware`, which must run before the React Router handler so `/api/v1/*` never returns an HTML auth redirect), the workflow orchestrator (the producer side that enqueues jobs), and graceful shutdown. Historically only `dev:server` (`tsx server.ts`) used it; the `start` script — and therefore every Dockerfile via `scripts/start.sh` — ran `react-router-serve ./build/server/index.js` instead. So in production **none** of that custom middleware ran.

Upgrading to React Router v8 (see the framework-mode skill and the v8 bump) surfaced why that matters. v8's CSRF protection compares the browser `Origin` header against `new URL(request.url).host`. The `@react-router/express` adapter only derives `request.url`'s host/proto from `X-Forwarded-Host` / `X-Forwarded-Proto` when Express `trust proxy` is enabled. These apps deploy behind Traefik, so without `trust proxy` a proxy that rewrites the `Host` header (or serves on a non-standard port) makes `request.url`'s host disagree with the browser `Origin`, and legitimate same-origin `POST` actions are aborted with `400 Bad Request`. `react-router-serve` builds its own Express app and exposes no hook to set `trust proxy`, so the fix is impossible there.

## Decision

Production runs the custom `server.ts` via `tsx`. The `start` script is `cross-env NODE_ENV=production tsx ./server.ts` (all Dockerfiles and `scripts/start.sh` reach it through `start`). `server.ts` calls `app.set('trust proxy', CONFIG.server.trustProxy)` before the request handler; `trustProxy` is parsed from the `TRUST_PROXY` env var (default `1` — a single Traefik hop — in production, `false` in dev). `react-router-serve` is no longer used to serve the app.

To make `tsx server.ts` resolve the built handler outside Vite, `#build/*` maps to `./build/*` in `tsconfig.json`, matching the existing `#app` / `#drizzle` subpath imports.

## Alternatives Considered

- **Keep `react-router-serve`, set `allowedActionOrigins`** — bakes the deploy domain into the build (it's build-time config, unknown for a template) and whitelists the origin rather than fixing host derivation. Also leaves `apiJsonMiddleware` and the workflow producer out of production.
- **Keep `react-router-serve`, rely on Traefik preserving the `Host` header** — works for the default Traefik config on standard ports (verified), but is silently fragile to non-standard ports or `Host` rewriting, and still runs none of the custom middleware in production.

## Consequences

- `trust proxy`, `apiJsonMiddleware`, the workflow producer, and graceful shutdown now all run in production — closing a latent gap, not just fixing CSRF. `req.ip` / `req.protocol` are also correct behind the proxy.
- The production image must include the app source (`server.ts`, `app/`, `drizzle/`, `tsconfig.json`) and `tsx` (already a runtime dependency, and the Dockerfiles' `COPY . /app` already ships the source). Validate the Docker build + boot on first deploy.
- Running the web process as producer means it initializes pg-boss. That exposed a bug in `@sprqvntrs/workflows` **≤ 0.2.3**: `createBoss` always passed `monitorStateIntervalSeconds` (as `undefined` when `debug` is off), and pg-boss asserts the value is `>= 1` whenever the key is *present*, crashing any `debug: false` (production) boot — the web process **and** `worker.ts`. Fixed upstream in **`@sprqvntrs/workflows@0.2.4`** (only spreads the key when enabled); this stack requires `^0.2.4` as its minimum. A short-lived local `pnpm patch` bridged the gap and has since been removed. Any app on this stack must stay on `>= 0.2.4`.
- `TRUST_PROXY` is configurable for multi-proxy topologies (e.g. Cloudflare → Traefik → app = `2`).

## References

- React Router v8 CSRF host check: `react-router/dist/**/lib/actions.ts` (`throwIfPotentialCSRFAttack`); express adapter host derivation: `@react-router/express` `createRemixRequest`.
- `.claude/skills/react-router-framework-mode/` — vendored v8 agent skill.
- `app/config/index.ts` (`parseTrustProxy`, `CONFIG.server.trustProxy`), `server.ts`, `.env.example` (`TRUST_PROXY`).
