/**
 * Which host is allowed to load the analytics tag.
 *
 * ONE HOST, NAMED, AND NOTHING ELSE. The Matomo site id belongs to
 * `translate.altan.fyi`. Stage rehearsals and a developer's laptop hit the same
 * code, and every visit they send would be counted as a real one, so the
 * measurement would stop meaning "somebody used the product". The gate is
 * therefore an allowlist of one name rather than a `NODE_ENV` check: a stage
 * container runs a production build too.
 *
 * The comparison is on the HOST NAME only. A port is stripped, so
 * `localhost:3000` and `localhost` are the same answer, and the value is lower
 * cased, because a Host header carries whatever case the client typed.
 */

/** The production host, and the only host this app reports visits from. */
export const ANALYTICS_HOST = 'translate.altan.fyi';

/**
 * Strips the port and the case off a Host header value.
 *
 * @param host A `Host` or `X-Forwarded-Host` header value, or null when absent.
 * @returns The bare lower-cased host name, empty when there was nothing to read.
 */
function bareHostName(host: string | null): string {
  if (host === null) return '';
  // An `X-Forwarded-Host` can carry a proxy chain. The first entry is the host
  // the browser asked for, which is the one this decision is about.
  const first = host.split(',')[0] ?? '';
  return first.trim().toLowerCase().split(':')[0] ?? '';
}

/**
 * Whether this request is the production site, and so may load the tracker.
 *
 * @param host A `Host` or `X-Forwarded-Host` header value, or null when absent.
 * @returns True only for the production host name.
 */
export function isAnalyticsHost(host: string | null): boolean {
  return bareHostName(host) === ANALYTICS_HOST;
}
