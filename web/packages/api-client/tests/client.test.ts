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

interface Seen {
  csrf: string | null;
  body: string;
  method: string;
}

describe('refreshCsrfToken', () => {
  const PROBLEM_TYPE = 'https://stuff.example/docs/api/problems.md#csrf-rejected';
  const MISMATCH = 'the CSRF token does not match';

  function refused(detail: string, status = 403): Response {
    return new Response(JSON.stringify({ type: PROBLEM_TYPE, title: 'x', status, detail }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });
  }

  function ok(): Response {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** A server that answers with `answers` in turn and records what it received. */
  function scripted(answers: Response[], seen: Seen[]): typeof fetch {
    return async (input, init): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({
        csrf: request.headers.get(CSRF_HEADER),
        body: await request.text(),
        method: request.method,
      });
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error('unexpected request');
      }
      return answer;
    };
  }

  /** A client whose token is 'old' until `refresh` answers. */
  function clientWith(
    answers: Response[],
    seen: Seen[],
    refresh: () => Promise<string | undefined>,
  ): ReturnType<typeof createApiClient<WritePaths>> {
    let token: string | undefined = 'old';
    return createApiClient<WritePaths>({
      baseUrl: 'https://stuff.example',
      fetch: scripted(answers, seen),
      csrfToken: (): string | undefined => token,
      refreshCsrfToken: async (): Promise<string | undefined> => {
        token = await refresh();
        return token;
      },
    });
  }

  it('sends a write refused for its token once more with the fresh token', async () => {
    for (const detail of [
      MISMATCH,
      'the CSRF token is missing (X-CSRF-Token header and cookie)',
      'the CSRF token is malformed',
    ]) {
      const seen: Seen[] = [];
      let refreshed = 0;
      const client = clientWith([refused(detail), ok()], seen, () => {
        refreshed += 1;
        return Promise.resolve('new');
      });

      const { data, response } = await client.PUT('/thing', { body: { name: 'x' } });

      expect(response.status).toBe(200);
      expect(data).toEqual({ status: 'ok' });
      expect(refreshed).toBe(1);
      expect(seen.map((request) => [request.method, request.csrf])).toEqual([
        ['PUT', 'old'],
        ['PUT', 'new'],
      ]);
      expect(seen.map((request) => request.body)).toEqual(['{"name":"x"}', '{"name":"x"}']);
    }
  });

  it('retries only once', async () => {
    const seen: Seen[] = [];
    let refreshed = 0;
    const client = clientWith([refused(MISMATCH), refused(MISMATCH)], seen, () => {
      refreshed += 1;
      return Promise.resolve('new');
    });

    const { response } = await client.DELETE('/thing');

    expect(response.status).toBe(403);
    expect(refreshed).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('does not retry refusals a new token cannot fix', async () => {
    for (const answer of [
      refused('the Origin header is not the app origin'),
      refused('Sec-Fetch-Site is not same-origin'),
      refused(MISMATCH, 401),
      new Response('not json', { status: 403 }),
      new Response(JSON.stringify({ type: 'x#other', detail: 'the CSRF token' }), { status: 403 }),
      new Response(JSON.stringify({ type: PROBLEM_TYPE }), { status: 403 }),
      new Response(JSON.stringify({ type: PROBLEM_TYPE, detail: 5 }), { status: 403 }),
      new Response(JSON.stringify({ type: 5, detail: 'the CSRF token' }), { status: 403 }),
      new Response(JSON.stringify({ detail: 'the CSRF token' }), { status: 403 }),
      new Response('null', { status: 403 }),
    ]) {
      const seen: Seen[] = [];
      let refreshed = 0;
      const client = clientWith([answer], seen, () => {
        refreshed += 1;
        return Promise.resolve('new');
      });
      await client.DELETE('/thing');
      expect(refreshed).toBe(0);
      expect(seen).toHaveLength(1);
    }
  });

  it('returns the refusal when there is no fresh token', async () => {
    const seen: Seen[] = [];
    const client = clientWith([refused(MISMATCH)], seen, () => Promise.resolve(undefined));
    const { response } = await client.DELETE('/thing');
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it('never retries a read and ignores the option without a token source', async () => {
    const seen: Seen[] = [];
    let refreshed = 0;
    const refresh = (): Promise<string | undefined> => {
      refreshed += 1;
      return Promise.resolve('new');
    };
    const client = clientWith([refused(MISMATCH)], seen, refresh);
    await client.GET('/health');
    expect(refreshed).toBe(0);
    expect(seen).toHaveLength(1);

    const plain: Seen[] = [];
    const withoutSource = createApiClient<WritePaths>({
      baseUrl: 'https://stuff.example',
      fetch: scripted([refused(MISMATCH)], plain),
      refreshCsrfToken: refresh,
    });
    const { response } = await withoutSource.DELETE('/thing');
    expect(response.status).toBe(403);
    expect(refreshed).toBe(0);
  });

  it('uses the global fetch when none is given', async () => {
    const seen: Seen[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = scripted([refused(MISMATCH), ok()], seen);
    try {
      const client = createApiClient<WritePaths>({
        baseUrl: 'https://stuff.example',
        csrfToken: (): string | undefined => 'old',
        refreshCsrfToken: () => Promise.resolve('new'),
      });
      const { response } = await client.DELETE('/thing');
      expect(response.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen.map((request) => request.csrf)).toEqual(['old', 'new']);
  });
});
