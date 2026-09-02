/**
 * Shared pagination utilities for API list endpoints.
 *
 * Provides consistent parsing, clamping, and response formatting for all
 * paginated list routes. Defaults: limit=20, max=100.
 */

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Parse and clamp `limit`/`offset` from a URLSearchParams or a plain Record.
 *
 * Clamping:
 *   - limit: clamp(parsed || DEFAULT, 1, MAX). NaN → default.
 *   - offset: max(0, parsed || 0). NaN → 0.
 *
 * The effective (clamped) values are returned and should be echoed back in
 * the response envelope.
 */
export function parsePaginationParams(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): PaginationParams {
  const get = (key: string): string | undefined => {
    if (source instanceof URLSearchParams) {
      return source.get(key) ?? undefined;
    }
    const val = source[key];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  const rawLimit = parseInt(get('limit') ?? '', 10);
  const rawOffset = parseInt(get('offset') ?? '', 10);

  const limit = clamp(
    isNaN(rawLimit) ? PAGINATION_DEFAULT_LIMIT : rawLimit,
    1,
    PAGINATION_MAX_LIMIT,
  );
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  return { limit, offset };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Build the standard JSON Response with the paginated envelope.
 * Echoes back the effective limit and offset (after clamping).
 */
export function paginatedJson<T>(result: PaginatedResult<T>): Response {
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}
