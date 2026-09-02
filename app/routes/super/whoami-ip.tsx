import type { Route } from './+types/whoami-ip';

import { CONFIG } from '#app/config';
import { clientIp, counterKey, readCounter, windowStart } from '#app/lib/abuse/rate-limit.server';

export const handle = {
  title: 'Client address',
};

// =============================================================================
// Proving the derived address is the CLIENT's, on the real deployment
// =============================================================================
// Superadmin only. The `_super` layout already runs `superadminMiddleware`, so
// this route neither re-checks the role nor exports a middleware of its own.
//
// WHY THIS PAGE IS WORTH A ROUTE. The rate limiter's whole correctness rests on
// one number: the trust depth used to read `X-Forwarded-For`. Get it wrong in
// one direction and every visitor behind the proxy is counted as ONE caller, so
// the first reader of the hour locks the app for everyone else. Get it wrong in
// the other and the header can be forged, so every request mints a fresh bucket
// and the limiter counts nothing. Neither failure raises an error, and neither
// is visible in a test, because a test supplies its own header. The only place
// the question can be answered is the real chain, in front of the real Traefik,
// which is what this page is.
//
// IT SHOWS THE HASH, NOT THE PEPPER. An operator can confirm that the derivation
// holds, that a reload from the same machine lands in the same bucket and a
// different machine does not, without the page ever printing the secret that
// makes the bucket keys unguessable.
//
// Copy here is plain English written inline, like `app/routes/super/llm.tsx`.
// Every user-facing string on a NON-admin surface comes from `app/locales`; the
// superadmin area is not translated and follows that convention.
// =============================================================================

export async function loader({ request }: Route.LoaderArgs) {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const address = clientIp(request);
  const key = address === null ? null : counterKey('ip', address);
  const count = key === null ? 0 : await readCounter(key);

  return {
    forwardedFor,
    address,
    key,
    count,
    // `trustProxy` accepts a hop count, a boolean or a list, so it is rendered
    // as text rather than as a number the page would have to interpret.
    trustProxy: String(CONFIG.server.trustProxy),
    windowStartedAt: windowStart(new Date()).toISOString(),
  };
}

/** One label and one value, in the house table shape. */
function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-b py-3 last:border-b-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.11em] text-primary">{label}</dt>
      <dd className="mt-1 break-all font-mono text-sm">{value}</dd>
      {hint !== undefined && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function WhoamiIpRoute({ loaderData }: Route.ComponentProps) {
  const { forwardedFor, address, key, count, trustProxy, windowStartedAt } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        What the rate limiter sees for this request. Load this page from a machine outside the server and check that the
        derived address is yours and not Traefik&apos;s.
      </p>

      <dl className="rounded-lg border bg-card p-4">
        <Row
          label="X-Forwarded-For, raw"
          value={forwardedFor ?? 'absent'}
          hint="The whole header, unparsed. Everything except the last entry is whatever the caller sent."
        />
        <Row
          label="Derived address"
          value={address ?? 'none'}
          hint="The last entry, which is the address Traefik itself observed. An absent header means no address limit applies."
        />
        <Row
          label="Counter key"
          value={key ?? 'none'}
          hint="The peppered hash the counter row is stored under. The pepper itself is never shown."
        />
        <Row label="Triggers counted this hour" value={String(count)} />
        <Row label="Window started at" value={windowStartedAt} hint="Fixed hourly windows, floored in UTC." />
        <Row
          label="TRUST_PROXY"
          value={trustProxy}
          hint="One hop: Traefik straight to Node, with no nginx in this image."
        />
      </dl>
    </div>
  );
}
