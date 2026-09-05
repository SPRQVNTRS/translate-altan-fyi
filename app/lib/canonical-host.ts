/**
 * The canonical host, and the 301 that carries a reader from the old one to it.
 *
 * THIS EXISTS BECAUSE BAY HAS NO REDIRECT MIDDLEWARE. Traefik routes both
 * `kenning.altan.fyi` and the legacy `translate.altan.fyi` to this one
 * container, and the same pair for their `stage.` forms. Nothing in front of
 * the app rewrites a host, so a canonical-host 301 has to come from the
 * container itself. `server.ts` is the only caller.
 *
 * The mapping is a SUFFIX SWAP, so one rule covers the apex and every
 * subdomain: `stage.translate.altan.fyi` becomes `stage.kenning.altan.fyi`,
 * and `translate.altan.fyi` becomes `kenning.altan.fyi`. The match is on a dot
 * boundary rather than a bare `endsWith`, so a look-alike name that merely ends
 * in those characters is not treated as ours.
 */

/** The old host, kept live and permanently redirected. */
export const LEGACY_HOST = 'translate.altan.fyi';

/** The host the product answers on today. */
export const CANONICAL_HOST = 'kenning.altan.fyi';

/**
 * The one path that is never redirected.
 *
 * Gatus probes the canonical host, so this exclusion changes nothing about the
 * live check. It is here for the prober that does NOT follow redirects: such a
 * client reads the 301 as a failure and pages somebody about a healthy
 * container.
 */
const HEALTHCHECK_PATH = '/healthcheck';

/**
 * Whether a host name is the legacy one, or a subdomain of it.
 *
 * @param name A lower-cased bare host name.
 * @returns True for `translate.altan.fyi` and anything under it.
 */
function isLegacyHost(name: string): boolean {
  if (name === LEGACY_HOST) return true;
  return name.endsWith('.' + LEGACY_HOST);
}

/**
 * Where a request should be permanently redirected, if anywhere.
 *
 * @param request.host The host Express resolved, `req.hostname`, which already
 *   respects the configured `trust proxy` hop count. Never a raw header.
 * @param request.path The path and query to preserve, `req.originalUrl`.
 * @returns The absolute target URL, or null when the request is already on the
 *   canonical host or is the health check.
 */
export function canonicalHostRedirect({ host, path }: { host: string | undefined; path: string }): string | null {
  if (host === undefined) return null;
  const name = host.toLowerCase();
  if (!isLegacyHost(name)) return null;
  if (path === HEALTHCHECK_PATH || path.startsWith(HEALTHCHECK_PATH + '?')) return null;

  const subdomain = name.slice(0, name.length - LEGACY_HOST.length);
  return `https://${subdomain}${CANONICAL_HOST}${path}`;
}
