import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, createApiClient } from '../src/index.ts';

interface Paths {
  '/health': {
    get: {
      responses: {
        200: { content: { 'application/json': { status: 'ok' } } };
      };
    };
  };
}

interface WritePaths extends Paths {
  '/thing': {
    put: {
      requestBody: { content: { 'application/json': { name: string } } };
      responses: {
        200: { content: { 'application/json': { status: 'ok' } } };
      };
    };
    delete: {
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
  readonly csrf: string | null;
}

function recordingFetch(requests: RecordedRequest[], body: unknown): typeof fetch {
  return (input, init): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      credentials: request.credentials,
      csrf: request.headers.get(CSRF_HEADER),
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
      {
        url: 'https://stuff.example/api/health',
        method: 'GET',
        credentials: 'same-origin',
        csrf: null,
      },
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

  it('sends the CSRF token on writes only', async () => {
    const requests: RecordedRequest[] = [];
    let token: string | undefined = 'first';
    const client = createApiClient<WritePaths>({
      baseUrl: 'https://stuff.example',
      fetch: recordingFetch(requests, { status: 'ok' }),
      csrfToken: (): string | undefined => token,
    });

    await client.GET('/health');
    await client.PUT('/thing', { body: { name: 'x' } });
    token = 'second';
    await client.DELETE('/thing');
    token = undefined;
    await client.DELETE('/thing');

    expect(requests.map((request) => [request.method, request.csrf])).toEqual([
      ['GET', null],
      ['PUT', 'first'],
      ['DELETE', 'second'],
      ['DELETE', null],
    ]);
    expect(CSRF_HEADER).toBe('X-CSRF-Token');
  });

  it('sends no CSRF header without a token source', async () => {
    const requests: RecordedRequest[] = [];
    const client = createApiClient<WritePaths>({
      baseUrl: 'https://stuff.example',
      fetch: recordingFetch(requests, { status: 'ok' }),
    });
    await client.PUT('/thing', { body: { name: 'x' } });
    expect(requests.map((request) => request.csrf)).toEqual([null]);
  });
});
