/**
 * CLI Transport Layer
 *
 * Pluggable abstraction for how CLI commands reach business logic.
 *
 * - `HttpTransport` issues authenticated `fetch` calls to `/api/v1/...`.
 *   Used when `--remote=<url>` or `--prod` is set on the command line.
 * - `DirectTransport` dispatches in-process to handlers registered against
 *   a path+method table. Used by default (no `--remote`) and during the
 *   incremental migration of commands from direct-DB to HTTP.
 *
 * Every call names the schema its response must satisfy. The transport is the
 * single I/O boundary where a wire payload (HTTP JSON) or an in-process domain
 * object (Drizzle rows) becomes a validated, typed value, so commands never see
 * an unparsed response and never hand-roll shape checks.
 *
 * Command files never branch on which transport is active, they always
 * call `transport.get/post/patch/delete(...)`. The active instance is set
 * once by `cli/index.ts` before commander parses argv, and imported as a
 * live binding by every command file.
 *
 * See `.adr/0001-cli-wraps-the-api.md` for rationale.
 */

import { z } from 'zod';

import type { JsonValue } from '#app/lib/json';

export type { JsonValue };

export type CliTransportMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Query-string inputs. `undefined`/`null` entries are dropped, not serialized. */
export type QueryParams = Record<
  string,
  string | number | boolean | Array<string | number> | null | undefined
>;

/**
 * Schema a caller supplies to describe the response it expects. Zod's input is
 * `unknown` by design, and that is precisely the boundary this schema closes.
 */
export type ResponseSchema<TValue> = z.ZodType<TValue>;

export interface CliTransport {
  get<TValue>(
    path: string,
    schema: ResponseSchema<TValue>,
    params?: QueryParams,
  ): Promise<TValue>;
  post<TValue>(path: string, schema: ResponseSchema<TValue>, body?: JsonValue): Promise<TValue>;
  patch<TValue>(path: string, schema: ResponseSchema<TValue>, body?: JsonValue): Promise<TValue>;
  delete<TValue>(path: string, schema: ResponseSchema<TValue>, params?: QueryParams): Promise<TValue>;
}

/**
 * Thrown when the API rejects credentials (401/403). Caught at the top
 * level in `cli/index.ts` and mapped to exit code 2.
 */
export class CliAuthError extends Error {
  constructor(message = 'invalid or missing API key') {
    super(message);
    this.name = 'CliAuthError';
  }
}

/**
 * Thrown for any other non-2xx response from the API. Carries the
 * server's `error` string for display, plus the HTTP status for callers
 * that want to differentiate (e.g. 404 vs 422).
 */
export class CliApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CliApiError';
    this.status = status;
  }
}

/** Standard `{ error, code }` envelope the API returns for non-2xx responses. */
const errorEnvelopeSchema = z.object({ error: z.string() });

/**
 * Validate a response against the schema the caller named. A mismatch is an
 * API/CLI contract break, so it surfaces as a `CliApiError` rather than a
 * raw Zod error.
 */
function decodeResponse<TValue, TPayload>(
  schema: ResponseSchema<TValue>,
  payload: TPayload,
): TValue {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  throw new CliApiError(`unexpected response shape: ${z.prettifyError(result.error)}`, 0);
}

function buildQueryString(params: QueryParams | undefined): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  if (entries.length === 0) return '';
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.set(key, String(value));
    }
  }
  return `?${search.toString()}`;
}

export class HttpTransport implements CliTransport {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  get<TValue>(
    path: string,
    schema: ResponseSchema<TValue>,
    params?: QueryParams,
  ): Promise<TValue> {
    return this.request('GET', `${path}${buildQueryString(params)}`, schema);
  }

  post<TValue>(path: string, schema: ResponseSchema<TValue>, body?: JsonValue): Promise<TValue> {
    return this.request('POST', path, schema, body);
  }

  patch<TValue>(path: string, schema: ResponseSchema<TValue>, body?: JsonValue): Promise<TValue> {
    return this.request('PATCH', path, schema, body);
  }

  delete<TValue>(
    path: string,
    schema: ResponseSchema<TValue>,
    params?: QueryParams,
  ): Promise<TValue> {
    return this.request('DELETE', `${path}${buildQueryString(params)}`, schema);
  }

  private async request<TValue>(
    method: CliTransportMethod,
    path: string,
    schema: ResponseSchema<TValue>,
    body?: JsonValue,
  ): Promise<TValue> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
    });
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliApiError(`could not connect to ${this.baseUrl} (${reason})`, 0);
    }

    if (response.status === 401 || response.status === 403) {
      throw new CliAuthError();
    }

    const text = await response.text();
    const payload = text.length > 0 ? parseJsonText(text) : undefined;

    if (!response.ok) {
      const envelope = errorEnvelopeSchema.safeParse(payload);
      throw new CliApiError(
        envelope.success ? envelope.data.error : `request failed (${response.status})`,
        response.status,
      );
    }

    return decodeResponse(schema, payload);
  }
}

/**
 * Decode a response body. Bodies that are not valid JSON are returned verbatim
 * so the caller's schema (or the error envelope) reports on the real payload
 * rather than on a parse failure.
 */
function parseJsonText(text: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Query values as a direct handler sees them, mirroring Express' `req.query`. */
export type DirectQuery = Record<string, string | string[]>;

/**
 * Handler signature for routes registered with DirectTransport. Mirrors
 * a simplified Express request shape so registering a route looks similar
 * to writing a route handler.
 */
export interface DirectHandlerContext {
  params: Record<string, string>;
  query: DirectQuery;
  body: JsonValue | undefined;
}

/**
 * What a direct handler produces: a live domain object graph (Drizzle rows,
 * envelopes) rather than serialized JSON. The caller's schema is what turns it
 * into a validated command-level value.
 */
export type DirectResponse = object | string | number | boolean | null;

export type DirectHandler = (ctx: DirectHandlerContext) => Promise<DirectResponse>;

interface CompiledRoute {
  method: CliTransportMethod;
  pattern: RegExp;
  paramNames: string[];
  handler: DirectHandler;
}

function compileRoutePattern(pattern: string) {
  const paramNames: string[] = [];
  const regexSrc = pattern.replace(/:(\w+)/g, (_, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${regexSrc}$`), paramNames };
}

/**
 * Read a query param that routes treat as single-valued. Repeated params keep
 * their first occurrence, matching Express' `req.query` conventions.
 */
export function singleQueryParam(query: DirectQuery, key: string): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

export class DirectTransport implements CliTransport {
  private readonly routes: CompiledRoute[] = [];

  /**
   * Register a route that this transport will dispatch to. Patterns use
   * Express-style `:param` placeholders. Subsequent M1 specs add their
   * route registrations next to the corresponding HTTP routes so the
   * two surfaces stay in sync.
   */
  register(method: CliTransportMethod, pattern: string, handler: DirectHandler): void {
    const { regex, paramNames } = compileRoutePattern(pattern);
    this.routes.push({ method, pattern: regex, paramNames, handler });
  }

  get<TValue>(
    path: string,
    schema: ResponseSchema<TValue>,
    params?: QueryParams,
  ): Promise<TValue> {
    return this.dispatch('GET', path, schema, params, undefined);
  }

  post<TValue>(path: string, schema: ResponseSchema<TValue>, body?: JsonValue): Promise<TValue> {
    return this.dispatch('POST', path, schema, undefined, body);
  }

  patch<TValue>(path: string, schema: ResponseSchema<TValue>, body?: JsonValue): Promise<TValue> {
    return this.dispatch('PATCH', path, schema, undefined, body);
  }

  delete<TValue>(
    path: string,
    schema: ResponseSchema<TValue>,
    params?: QueryParams,
  ): Promise<TValue> {
    return this.dispatch('DELETE', path, schema, params, undefined);
  }

  private async dispatch<TValue>(
    method: CliTransportMethod,
    path: string,
    schema: ResponseSchema<TValue>,
    query: QueryParams | undefined,
    body: JsonValue | undefined,
  ): Promise<TValue> {
    const [pathOnly] = path.split('?');
    const normalizedQuery = normalizeQuery(query);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathOnly);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      const result = await route.handler({ params, query: normalizedQuery, body });
      return decodeResponse(schema, result);
    }
    throw new CliApiError(
      `no DirectTransport route registered for ${method} ${pathOnly}`,
      404,
    );
  }
}

function normalizeQuery(query: QueryParams | undefined) {
  const out: DirectQuery = {};
  if (!query) return out;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) out[key] = value.map(String);
    else out[key] = String(value);
  }
  return out;
}

export interface CreateTransportOptions {
  remote?: string;
  token?: string;
}

/**
 * Build the right transport for the given flag set. Spec 01 wires this
 * up in `cli/index.ts` from global flags + env vars.
 */
export function createTransport(opts: CreateTransportOptions): CliTransport {
  if (opts.remote) {
    if (!opts.token) {
      throw new CliAuthError(
        'remote mode requires an API key, set TRANSLATE_API_KEY or pass --token',
      );
    }
    return new HttpTransport(opts.remote, opts.token);
  }
  return new DirectTransport();
}

/**
 * Live-binding singleton imported by every command file. `cli/index.ts`
 * calls `setTransport()` once during startup, after parsing global flags
 * but before commander dispatches to a subcommand.
 */
export let transport: CliTransport = new DirectTransport();

export function setTransport(next: CliTransport): void {
  transport = next;
}

/**
 * Type guard: true when the active transport is an HttpTransport instance.
 * Use in command files to branch on direct-DB vs. remote-API paths.
 */
export function isHttpTransport(t: CliTransport): t is HttpTransport {
  return t instanceof HttpTransport;
}
