# Launch checks

## M175/03 gatus

**Date:** 2026-09-03

**Endpoint name:** `translate.altan.fyi Health` (group `external`, Gatus key
`external_translate-altan-fyi-health`).

**Target:** `https://translate.altan.fyi/healthcheck`, probed every 1m.

**Conditions:** `[STATUS] == 200`, `[BODY] == OK`, `[RESPONSE_TIME] < 2000`.
The body condition is deliberate. Traefik or a CDN can answer 200 with an error
page, so only the literal `OK` proves the Node process replied.

**Alerting:** the same `custom` channel every other SPRQVNTRS endpoint uses. It
posts to the Campfire `h-sprqvntrs` room (room 7) as the Argus bot.
`failure-threshold: 3`, `send-on-resolved: true`. Telegram stays the default
channel for the endpoints that opt into it.

**Status seen:** healthy. Read from the Gatus API on the infra host at
`GET /api/v1/endpoints/statuses`. The first two probes after the deploy:

| Timestamp (UTC) | Success | HTTP | Duration |
|---|---|---|---|
| 2026-09-03T07:15:22Z | true | 200 | 97.5 ms |
| 2026-09-03T07:16:22Z | true | 200 | 8.9 ms |

All three conditions returned `success: true` on both probes.

**Where Gatus runs from.** Gatus runs on the **infra** server,
`sprqvntrs-infra` (Tailscale `100.64.0.5`, public `178.105.10.243`), as the
`gatus` container. Its dashboard is VPN-only at `status.infra.argo.sprqvntrs.com`.
The probe therefore leaves a Hetzner datacenter IP, NOT a residential one.

**Caveat: a datacenter-ASN probe can be held off by CrowdSec.** CrowdSec
enforces at nftables, ahead of Traefik, and it has held off datacenter-ASN
traffic on other SPRQVNTRS sites before. If this endpoint ever goes red while
the site is reachable from a normal browser, check whether the Gatus egress IP
has been banned before treating it as an outage. A red Gatus lane is evidence
that the probe failed, not proof that the service is down.

**Not probed on purpose:** `stage.translate.altan.fyi`. It sits behind basic
auth (it answers 401 to an unauthenticated probe) and it is a rehearsal host, so
a red stage is not an incident.

**Config:** `bay-sprqvntrs/files/gatus/config.yaml`, commit `e3ee90c`.
Deployed with `bin/bay deploy production --tags deploy_stack -r infra`. The
narrower `--tags gatus` does NOT render config files; `config_files` are written
by the `deploy_stack` role, which also restarts the owning container when the
file changes.

## M175/03 matomo

**Site:** Matomo site id `19`, alias `translate` in `djinn/matomo/lib/sites.ts`,
on `https://matomo.sprqvntrs.com/`.

**Tag:** `app/components/site/matomo.tsx`, rendered from `app/root.tsx` only when
the request host is `translate.altan.fyi` (`app/lib/analytics-host.ts`). Stage and
localhost render no tag, which `tests/unit/landing-and-analytics.test.ts` proves.

**No cookie banner, on purpose.** The snippet calls `disableCookies` and
`setDoNotTrack`, so nothing is stored on the device and a Do Not Track browser is
not counted. `setCustomUrl` reports the PATH only: a results page is `/?q=<word>`,
and the privacy policy states that Matomo is never told what you searched for.

**Evidence of a real visit:** see below, filled in after the deploy.

## M175/03 announcement

pending: the operator posts the announcement; record where and when here
