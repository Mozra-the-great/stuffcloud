import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/index.ts';

interface Paths {
  '/health': {
    get: {
      responses: {
        200: { content: { 'application/json': { status: 'ok' } } };
      };
    };
  };
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly credentials: string;
}

function recordingFetch(requests: RecordedRequest[], body: unknown): typeof fetch {
  return (input, init): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      credentials: request.credentials,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

describe('createApiClient', () => {
  it('sends typed requests to the base URL with same-origin credentials', async () => {
    const requests: RecordedRequest[] = [];
    const client = createApiClient<Paths>({
      baseUrl: 'https://stuff.example/api',
      fetch: recordingFetch(requests, { status: 'ok' }),
    });

    const { data, error } = await client.GET('/health');

    expect(error).toBeUndefined();
    expect(data).toEqual({ status: 'ok' });
    expect(requests).toEqual([
      { url: 'https://stuff.example/api/health', method: 'GET', credentials: 'same-origin' },
    ]);
  });

  it('falls back to the global fetch when none is given', async () => {
    const requests: RecordedRequest[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = recordingFetch(requests, { status: 'ok' });
    try {
      const client = createApiClient<Paths>({ baseUrl: 'https://stuff.example' });
      await client.GET('/health');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests.map((request) => request.url)).toEqual(['https://stuff.example/health']);
  });
});
