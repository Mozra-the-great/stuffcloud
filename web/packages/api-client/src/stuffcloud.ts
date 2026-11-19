import type { Client } from 'openapi-fetch';
import { createApiClient, type ApiClientOptions } from './client.ts';
import type { paths } from './generated/schema';

/** A client typed by the OpenAPI document of `app` (`docs/api/openapi.json`). */
export type StuffcloudClient = Client<paths>;

/**
 * Creates the client the web UI uses for every call to the server (API-first: no hand-built
 * requests). `baseUrl` is the origin of the app address; the paths carry `/api/v1`.
 */
export function createStuffcloudClient(options: ApiClientOptions): StuffcloudClient {
  return createApiClient<paths>(options);
}
