import type { BrowserContext, Page, Request, WebSocket } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { createA11yGate } from '../e2e/support/a11y.ts';
import { noise, sampleFile, sha256Hex } from '../e2e/support/files.ts';
import {
  describeViolations,
  fileNeedles,
  ignoredHosts,
  inspect,
  isIgnoredHost,
  NetworkRecorder,
  type RecordedRequest,
  type Rule,
} from '../e2e/support/network.ts';

/**
 * The privacy check of the end-to-end suite is only worth something if it can fail, so its
 * rules are tested here without a browser: both sides of every rule, every encoding it looks for.
 */

const ORIGIN = 'http://127.0.0.1:4173';

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    url: `${ORIGIN}/assets/tool-abc123.js`,
    method: 'GET',
    resourceType: 'script',
    headers: { accept: '*/*' },
    body: null,
    ...overrides,
  };
}

function rules(found: readonly { readonly rule: Rule }[]): Rule[] {
  return found.map((violation) => violation.rule);
}

describe('noise and sample files', () => {
  it('is the same every time and as long as asked', () => {
    expect(noise(100, 7)).toEqual(noise(100, 7));
    expect(noise(0, 7)).toHaveLength(0);
    expect(noise(1, 7)).toHaveLength(1);
    expect(noise(4096, 7)).toHaveLength(4096);
  });

  it('differs between seeds', () => {
    expect(noise(64, 1).equals(noise(64, 2))).toBe(false);
  });

  it('has no repeated 16-byte window, so a hit in a request is never a coincidence', () => {
    const bytes = noise(20_000, 0x1234abcd);
    const seen = new Set<string>();
    for (let at = 0; at + 16 <= bytes.length; at += 1) {
      seen.add(bytes.subarray(at, at + 16).toString('hex'));
    }
    expect(seen.size).toBe(bytes.length - 15);
  });

  it('refuses a size that is not a whole number of bytes or a zero seed', () => {
    expect(() => noise(-1, 1)).toThrow('size must be a whole number of bytes, got -1');
    expect(() => noise(1.5, 1)).toThrow('size must be a whole number of bytes, got 1.5');
    expect(() => noise(10, 0)).toThrow('the seed must be a non-zero integer');
    expect(() => noise(10, 0.5)).toThrow('the seed must be a non-zero integer');
  });

  it('describes a sample file and hashes it with SHA-256', () => {
    const file = sampleFile('a.bin', 10, 5);
    expect(file).toMatchObject({ name: 'a.bin', mimeType: 'application/octet-stream' });
    expect(file.buffer).toEqual(noise(10, 5));
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('fileNeedles', () => {
  const file = noise(500, 99);

  it('refuses an empty file', () => {
    expect(() => fileNeedles(Buffer.alloc(0))).toThrow('an empty file has nothing to look for');
  });

  it('searches a file shorter than a window whole', () => {
    const tiny = Buffer.from([1, 2, 3]);
    const raw = fileNeedles(tiny).filter((needle) => needle.form === 'raw');
    expect(raw).toHaveLength(1);
    expect(raw[0]?.bytes).toEqual(tiny);
  });

  it('covers the start, the middle and the end of the file', () => {
    const raw = fileNeedles(file)
      .filter((needle) => needle.form === 'raw')
      .map((needle) => needle.bytes);
    expect(raw).toEqual([file.subarray(0, 24), file.subarray(238, 262), file.subarray(476, 500)]);
  });

  const encodings: readonly [string, (bytes: Buffer) => string][] = [
    ['raw bytes', (bytes) => bytes.toString('latin1')],
    ['hex', (bytes) => bytes.toString('hex')],
    ['base64', (bytes) => bytes.toString('base64')],
    ['base64url', (bytes) => bytes.toString('base64url')],
    [
      'percent escapes',
      (bytes) => [...bytes].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    ],
    ['percent-escaped base64', (bytes) => encodeURIComponent(bytes.toString('base64'))],
  ];

  describe.each(encodings)('finds the file as %s', (_name, encode) => {
    it.each([
      ['the whole file', 0, 500],
      ['a chunk from byte 0', 0, 200],
      ['a chunk from byte 1', 1, 300],
      ['a chunk from byte 2', 2, 300],
      ['a chunk from the middle', 100, 400],
      ['the tail', 250, 500],
    ])('in %s', (_where, from, to) => {
      const found = inspect(
        request({ url: `${ORIGIN}/assets/x.js?d=${encode(file.subarray(from, to))}` }),
        ORIGIN,
        fileNeedles(file),
      );
      expect(rules(found)).toContain('content');
    });
  });

  it('finds it in a body and in a header too', () => {
    const needles = fileNeedles(file);
    expect(rules(inspect(request({ body: file }), ORIGIN, needles))).toContain('content');
    expect(
      rules(inspect(request({ headers: { 'x-trace': file.toString('hex') } }), ORIGIN, needles)),
    ).toContain('content');
  });

  it('does not find another file, or the same file one byte off in every window', () => {
    const needles = fileNeedles(file);
    const other = noise(500, 100);
    expect(rules(inspect(request({ body: other }), ORIGIN, needles))).not.toContain('content');
    const damaged = Buffer.from(file);
    for (let at = 10; at < damaged.length; at += 20) {
      damaged[at] = (damaged[at] ?? 0) ^ 0xff;
    }
    expect(rules(inspect(request({ body: damaged }), ORIGIN, needles))).not.toContain('content');
  });
});

describe('inspect', () => {
  it('accepts a GET of an own asset, a HEAD, and the page itself', () => {
    expect(inspect(request(), ORIGIN)).toEqual([]);
    expect(inspect(request({ method: 'HEAD' }), ORIGIN)).toEqual([]);
    expect(
      inspect(
        request({ url: `${ORIGIN}/tools/sample-tool?category=text`, resourceType: 'document' }),
        ORIGIN,
      ),
    ).toEqual([]);
  });

  it('ignores data: and blob: URLs, which never leave the browser', () => {
    expect(
      inspect(request({ url: 'data:,', method: 'POST', body: Buffer.from('x') }), ORIGIN),
    ).toEqual([]);
    expect(inspect(request({ url: `blob:${ORIGIN}/1234`, resourceType: 'fetch' }), ORIGIN)).toEqual(
      [],
    );
  });

  it('flags another origin, on every difference of scheme, host and port', () => {
    for (const url of [
      'https://collector.example.invalid/assets/a.js',
      'http://127.0.0.1:4174/assets/a.js',
      'https://127.0.0.1:4173/assets/a.js',
      'http://localhost:4173/assets/a.js',
    ]) {
      expect(rules(inspect(request({ url }), ORIGIN))).toEqual(['origin']);
    }
  });

  it('flags every method but GET and HEAD', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(rules(inspect(request({ method }), ORIGIN))).toEqual(['method']);
    }
  });

  it('flags a body, but not an empty one', () => {
    expect(rules(inspect(request({ body: Buffer.from('x') }), ORIGIN))).toEqual(['body']);
    expect(inspect(request({ body: Buffer.alloc(0) }), ORIGIN)).toEqual([]);
  });

  it('flags a request outside /assets/ unless it is the page', () => {
    for (const url of [
      `${ORIGIN}/__leak`,
      `${ORIGIN}/`,
      `${ORIGIN}/assetsx/a.js`,
      `${ORIGIN}/api/x`,
    ]) {
      expect(rules(inspect(request({ url, resourceType: 'fetch' }), ORIGIN))).toEqual(['path']);
    }
    expect(inspect(request({ url: `${ORIGIN}/`, resourceType: 'document' }), ORIGIN)).toEqual([]);
  });

  it('flags a query string on an asset, however short', () => {
    expect(rules(inspect(request({ url: `${ORIGIN}/assets/a.js?x` }), ORIGIN))).toEqual(['query']);
    expect(inspect(request({ url: `${ORIGIN}/assets/a.js` }), ORIGIN)).toEqual([]);
  });

  it('reports every rule a request breaks, with a shortened URL', () => {
    const long = `https://collector.example.invalid/${'a'.repeat(300)}`;
    const found = inspect(
      request({ url: long, method: 'POST', resourceType: 'fetch', body: Buffer.from('payload') }),
      ORIGIN,
    );
    expect(rules(found)).toEqual(['origin', 'method', 'body', 'path']);
    expect(found.every((violation) => violation.url.length === 160)).toBe(true);
  });

  it('survives a URL that is not valid percent-encoding', () => {
    const file = noise(100, 3);
    const found = inspect(
      request({ url: `${ORIGIN}/assets/a.js?d=%E0%A4%A` }),
      ORIGIN,
      fileNeedles(file),
    );
    expect(rules(found)).toEqual(['query']);
  });

  it('describes violations one per line', () => {
    const found = inspect(request({ method: 'POST' }), ORIGIN);
    expect(describeViolations(found)).toBe(
      `[method] ${ORIGIN}/assets/tool-abc123.js (POST request)`,
    );
    expect(describeViolations([])).toBe('');
  });
});

describe('ignored hosts', () => {
  it('reads a comma separated list, trimmed, lowercase, without empty entries', () => {
    expect(ignoredHosts(' A.example , ,b.example')).toEqual(['a.example', 'b.example']);
    expect(ignoredHosts('')).toEqual([]);
    expect(ignoredHosts(undefined)).toEqual([]);
  });

  it('matches the host and its subdomains, not a host that merely ends the same way', () => {
    const hosts = ['av.example'];
    expect(isIgnoredHost('av.example', hosts)).toBe(true);
    expect(isIgnoredHost('ff.av.example', hosts)).toBe(true);
    expect(isIgnoredHost('FF.AV.EXAMPLE', hosts)).toBe(true);
    expect(isIgnoredHost('notav.example', hosts)).toBe(false);
    expect(isIgnoredHost('av.example.invalid', hosts)).toBe(false);
    expect(isIgnoredHost('av.example', [])).toBe(false);
  });
});

type Listener = (value: never) => void;

/** The two events of a browser context the recorder listens to. */
class FakeContext {
  readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (value: unknown) => void)(value);
    }
  }
}

function fakeRequest(recorded: RecordedRequest): Request {
  return {
    url: () => recorded.url,
    method: () => recorded.method,
    resourceType: () => recorded.resourceType,
    headers: () => recorded.headers,
    postDataBuffer: () => recorded.body,
  } as unknown as Request;
}

describe('NetworkRecorder', () => {
  function setup(ignored: readonly string[] = []): {
    context: FakeContext;
    recorder: NetworkRecorder;
  } {
    const context = new FakeContext();
    return {
      context,
      recorder: new NetworkRecorder(context as unknown as BrowserContext, ORIGIN, ignored),
    };
  }

  it('records what a context requests and is clean for own assets', () => {
    const { context, recorder } = setup();
    context.emit('request', fakeRequest(request()));
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.violations()).toEqual([]);
    expect(() => {
      recorder.assertClean();
    }).not.toThrow();
  });

  it('fails assertClean with every violation in the message', () => {
    const { context, recorder } = setup();
    context.emit('request', fakeRequest(request({ method: 'POST', body: Buffer.from('x') })));
    expect(() => {
      recorder.assertClean();
    }).toThrow(/the page sent something it must not:\n\[method\].*\n\[body\]/);
  });

  it('looks for the bytes of watched files only, and from the moment they are watched', () => {
    const { context, recorder } = setup();
    const file = noise(300, 11);
    const leaking = request({ url: `${ORIGIN}/assets/a.js?d=${file.toString('hex')}` });
    context.emit('request', fakeRequest(leaking));
    expect(rules(recorder.violations())).toEqual(['query']);
    recorder.watch(file);
    expect(rules(recorder.violations())).toEqual(['query', 'content']);
  });

  it('counts a WebSocket of any page as a violation', () => {
    const { context, recorder } = setup();
    const listeners = new Map<string, (value: WebSocket) => void>();
    const page = {
      on: (event: string, listener: (value: WebSocket) => void): void => {
        listeners.set(event, listener);
      },
    } as unknown as Page;
    context.emit('page', page);
    listeners.get('websocket')?.({ url: () => 'wss://collector.example.invalid/' } as WebSocket);
    expect(recorder.violations()).toEqual([
      {
        rule: 'websocket',
        url: 'wss://collector.example.invalid/',
        detail: 'a WebSocket was opened',
      },
    ]);
  });

  it('leaves out requests to ignored hosts, and only those', () => {
    const { context, recorder } = setup(['av.example']);
    context.emit(
      'request',
      fakeRequest(request({ url: 'http://ff.av.example/x', method: 'POST' })),
    );
    expect(recorder.requests).toHaveLength(0);
    context.emit(
      'request',
      fakeRequest(request({ url: 'http://other.example/x', method: 'POST' })),
    );
    expect(recorder.requests).toHaveLength(1);
    expect(rules(recorder.violations())).toContain('origin');
  });

  it('stops listening on dispose', () => {
    const { context, recorder } = setup();
    recorder.dispose();
    context.emit('request', fakeRequest(request({ method: 'POST' })));
    expect(recorder.requests).toHaveLength(0);
    expect([...context.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});

describe('createA11yGate', () => {
  it('is off without a runner: checking does nothing', async () => {
    const gate = createA11yGate();
    expect(gate.enabled).toBe(false);
    await expect(gate.check({} as Page, 'home')).resolves.toBeUndefined();
  });

  it('runs the runner with the page and the label when there is one', async () => {
    const runner = vi.fn(() => Promise.resolve());
    const gate = createA11yGate(runner);
    const page = {} as Page;
    expect(gate.enabled).toBe(true);
    await gate.check(page, 'tools');
    expect(runner).toHaveBeenCalledExactlyOnceWith(page, 'tools');
  });

  it('passes a violation of the runner on', async () => {
    const gate = createA11yGate(() => Promise.reject(new Error('1 violation')));
    await expect(gate.check({} as Page, 'x')).rejects.toThrow('1 violation');
  });
});
