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
  const client = createClient<Paths>({
    baseUrl: options.baseUrl,
    credentials: 'same-origin',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (options.csrfToken !== undefined) {
    client.use(csrfMiddleware(options.csrfToken));
  }
  return client;
}
