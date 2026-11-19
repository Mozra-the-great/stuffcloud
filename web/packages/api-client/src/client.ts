import createClient, { type Client, type Middleware } from 'openapi-fetch';

/** Name of the header that carries the CSRF token on every write (SPEC 5.5). */
export const CSRF_HEADER = 'X-CSRF-Token';

/** Methods that change nothing and therefore need no CSRF token. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiClientOptions {
  /** Origin and optional path prefix of the API, for example `https://stuff.example/api`. */
  readonly baseUrl: string;
  /** Fetch implementation; defaults to the global `fetch`. Tests and SSR pass their own. */
  readonly fetch?: typeof fetch;
  /**
   * The CSRF token for writes: the `csrf_token` of `GET /api/v1/auth/session`. It is sent as
   * `X-CSRF-Token` on every request other than `GET`, `HEAD` and `OPTIONS`; without it the
   * server refuses writes (`csrf-rejected`). Called per request, so a token that changes
   * (after a login) is picked up.
   */
  readonly csrfToken?: () => string | undefined;
  /**
   * Fetches a fresh CSRF token (call `GET /api/v1/auth/session`, keep the new `csrf_token` where
   * `csrfToken` reads it, and return it). When the server refuses a write because of its CSRF
   * token (the token is missing, malformed or not the one of the session: another tab logged in
   * again, or the browser lost the cookie), the client calls this once and sends the same write
   * again with the new token. A second refusal is returned as the result; other refusals
   * (foreign origin, cross-site request) are never retried. Without `csrfToken` this has no
   * effect.
   */
  readonly refreshCsrfToken?: () => Promise<string | undefined>;
}

/** The marker of the problem type of a refused CSRF check (`docs/api/problems.md`). */
const CSRF_REJECTED = '#csrf-rejected';

/**
 * Whether a response says the write was refused because of its CSRF token (and not because of
 * the origin or the fetch metadata, which a new token cannot fix).
 */
async function refusedForToken(response: Response): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }
  try {
    const problem: unknown = await response.clone().json();
    return (
      typeof problem === 'object' &&
      problem !== null &&
      'type' in problem &&
      typeof problem.type === 'string' &&
      problem.type.endsWith(CSRF_REJECTED) &&
      'detail' in problem &&
      typeof problem.detail === 'string' &&
      problem.detail.includes('CSRF token')
    );
  } catch {
    return false;
  }
}

/** Wraps `send` so a write refused for its CSRF token is sent once more with a fresh one. */
function retryingFetch(
  send: (request: Request) => Promise<Response>,
  refresh: () => Promise<string | undefined>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const again = SAFE_METHODS.has(request.method) ? undefined : request.clone();
    const response = await send(request);
    if (again === undefined || !(await refusedForToken(response))) {
      return response;
    }
    const token = await refresh();
    if (token === undefined) {
      return response;
    }
    again.headers.set(CSRF_HEADER, token);
    return send(again);
  };
}

/** Adds the CSRF header to writes. */
function csrfMiddleware(csrfToken: () => string | undefined): Middleware {
  return {
    onRequest({ request }): Request {
      const token = csrfToken();
      if (token !== undefined && !SAFE_METHODS.has(request.method)) {
        request.headers.set(CSRF_HEADER, token);
      }
      return request;
    },
  };
}

/**
 * Creates a client typed by the `paths` interface that `pnpm generate` writes to
 * `src/generated/schema.d.ts` from the OpenAPI document of `app`.
 *
 * Cookies are sent (`same-origin`) so the session of the logged-in user applies; the client
 * never reads or stores credentials itself. The browser adds the `Origin` header the server
 * checks on writes.
 */
export function createApiClient<Paths extends object>(options: ApiClientOptions): Client<Paths> {
  const { fetch: custom, refreshCsrfToken } = options;
  const send = (request: Request): Promise<Response> => (custom ?? globalThis.fetch)(request);
  const client = createClient<Paths>({
    baseUrl: options.baseUrl,
    credentials: 'same-origin',
    ...(refreshCsrfToken !== undefined && options.csrfToken !== undefined
      ? { fetch: retryingFetch(send, refreshCsrfToken) }
      : custom === undefined
        ? {}
        : { fetch: custom }),
  });
  if (options.csrfToken !== undefined) {
    client.use(csrfMiddleware(options.csrfToken));
  }
  return client;
}
