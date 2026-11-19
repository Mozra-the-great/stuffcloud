import { describe, expect, it } from 'vitest';
import { createStuffcloudClient, type components } from '../src/index.ts';

type ReservedNames = components['schemas']['ReservedNames'];

function answering(status: number, body: unknown, seen: Request[]): typeof fetch {
  return (input, init): Promise<Response> => {
    seen.push(input instanceof Request ? input : new Request(input, init));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': status < 400 ? 'application/json' : 'application/problem+json',
        },
      }),
    );
  };
}

describe('createStuffcloudClient', () => {
  it('reads a settings group with the generated types', async () => {
    const seen: Request[] = [];
    const document = {
      names: ['intranet'],
      meta: {
        id: 1,
        etag: '"abc"',
        created_at: '2026-11-19T00:00:00Z',
        updated_at: '2026-11-19T00:00:00Z',
      },
    };
    const client = createStuffcloudClient({
      baseUrl: 'http://stuff.localhost:8080',
      fetch: answering(200, document, seen),
    });

    const { data, error } = await client.GET('/api/v1/settings/reserved-names');

    expect(error).toBeUndefined();
    expect(data?.names).toEqual(['intranet']);
    expect(data?.meta.etag).toBe('"abc"');
    expect(seen.map((request) => request.url)).toEqual([
      'http://stuff.localhost:8080/api/v1/settings/reserved-names',
    ]);
  });

  it('sends a typed PUT with If-Match and returns problem documents as errors', async () => {
    const seen: Request[] = [];
    const problem = {
      type: 'https://github.com/Mozra-the-great/stuffcloud/blob/main/docs/api/problems.md#unauthenticated',
      title: 'Authentication required',
      status: 401,
    };
    const client = createStuffcloudClient({
      baseUrl: 'http://stuff.localhost:8080',
      fetch: answering(401, problem, seen),
    });
    const body: ReservedNames = { names: ['intranet', 'wiki'] };

    const { data, error } = await client.PUT('/api/v1/settings/reserved-names', {
      params: { query: { dry_run: true }, header: { 'If-Match': '"abc"' } },
      body,
    });

    expect(data).toBeUndefined();
    expect(error).toEqual(problem);
    const [request] = seen;
    expect(request?.method).toBe('PUT');
    expect(request?.url).toBe(
      'http://stuff.localhost:8080/api/v1/settings/reserved-names?dry_run=true',
    );
    expect(request?.headers.get('if-match')).toBe('"abc"');
    expect(await request?.json()).toEqual(body);
  });
});
