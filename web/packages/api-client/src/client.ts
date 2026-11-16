import createClient, { type Client } from 'openapi-fetch';

export interface ApiClientOptions {
  /** Origin and optional path prefix of the API, for example `https://stuff.example/api`. */
  readonly baseUrl: string;
  /** Fetch implementation; defaults to the global `fetch`. Tests and SSR pass their own. */
  readonly fetch?: typeof fetch;
}

/**
 * Creates a client typed by the `paths` interface that `pnpm generate` writes to
 * `src/generated/schema.d.ts` from the OpenAPI document of `app`.
 *
 * Cookies are sent (`same-origin`) so the session of the logged-in user applies; the client
 * never reads or stores credentials itself.
 */
export function createApiClient<Paths extends object>(options: ApiClientOptions): Client<Paths> {
  return createClient<Paths>({
    baseUrl: options.baseUrl,
    credentials: 'same-origin',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
