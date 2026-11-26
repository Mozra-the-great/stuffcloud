import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateScores,
  formatScoreFailures,
  formatScores,
  median,
  type RunScores,
} from '../scripts/lighthouse-scores.ts';
import type { LighthouseBudget } from '../scripts/perf-budget.ts';
import { serveBuild, type RunningServer } from '../scripts/static-server.ts';

const BUDGET: LighthouseBudget = {
  runs: 5,
  minScores: { performance: 0.95, accessibility: 0.9, 'best-practices': 1 },
};

function run(performance: number, accessibility = 1, bestPractices = 1): RunScores {
  return { performance, accessibility, 'best-practices': bestPractices };
}

describe('median', () => {
  it('takes the middle value of an odd count, whatever the order', () => {
    expect(median([5])).toBe(5);
    expect(median([0.9, 0.5, 0.7])).toBe(0.7);
    expect(median([3, 1, 2, 5, 4])).toBe(3);
  });

  it('takes the mean of the middle two for an even count', () => {
    expect(median([1, 4])).toBe(2.5);
    expect(median([9, 1, 3, 5])).toBe(4);
  });

  it('does not reorder its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('refuses no values', () => {
    expect(() => median([])).toThrow('the median of no values is undefined');
  });
});

describe('evaluateScores', () => {
  it('passes a median exactly at the minimum, fails just below it, per category', () => {
    const at = evaluateScores([run(0.95), run(0.95), run(0.95)], BUDGET);
    expect(at.find((finding) => finding.category === 'performance')).toMatchObject({
      median: 0.95,
      min: 0.95,
      ok: true,
    });
    const below = evaluateScores([run(0.94), run(0.94), run(0.94)], BUDGET);
    expect(below.map((finding) => finding.ok)).toEqual([false, true, true]);
    const a11y = evaluateScores([run(1, 0.89), run(1, 0.89), run(1, 0.89)], BUDGET);
    expect(a11y.map((finding) => finding.ok)).toEqual([true, false, true]);
    const practices = evaluateScores([run(1, 1, 0.99), run(1, 1, 0.99), run(1, 1, 0.99)], BUDGET);
    expect(practices.map((finding) => finding.ok)).toEqual([true, true, false]);
  });

  it('judges the median, not the best or the worst run', () => {
    const noisy = evaluateScores([run(0.99), run(0.8), run(0.96), run(0.7), run(0.97)], BUDGET);
    expect(noisy[0]).toMatchObject({ median: 0.96, ok: true, runs: [0.99, 0.8, 0.96, 0.7, 0.97] });
    const unlucky = evaluateScores([run(0.99), run(0.99), run(0.9), run(0.9), run(0.9)], BUDGET);
    expect(unlucky[0]).toMatchObject({ median: 0.9, ok: false });
  });

  it('lists the categories in the order of the budget file', () => {
    expect(evaluateScores([run(1)], BUDGET).map((finding) => finding.category)).toEqual([
      'performance',
      'accessibility',
      'best-practices',
    ]);
  });

  it('refuses no runs', () => {
    expect(() => evaluateScores([], BUDGET)).toThrow('no Lighthouse run to evaluate');
  });
});

describe('score reports', () => {
  const findings = evaluateScores([run(0.96, 0.8), run(0.94, 0.8), run(0.97, 0.8)], BUDGET);

  it('prints a table in points with every run', () => {
    expect(formatScores(findings)).toBe(
      [
        '| | Category | Median | Minimum | Runs |',
        '|---|---|---|---|---|',
        '| ok | performance | 96 | 95 | 96, 94, 97 |',
        '| BELOW | accessibility | 80 | 90 | 80, 80, 80 |',
        '| ok | best-practices | 100 | 100 | 100, 100, 100 |',
      ].join('\n'),
    );
  });

  it('names every category below the minimum, and says the minimum is not lowered', () => {
    const message = formatScoreFailures(findings);
    expect(message).toContain('Lighthouse: 1 category below the minimum:');
    expect(message).toContain('- accessibility: median 80 of runs 80, 80, 80, minimum 90');
    expect(message).not.toContain('- performance');
    expect(message).toContain('.lighthouse/');
    expect(message).toContain('not lowered');
    const two = evaluateScores([run(0.5, 0.5)], BUDGET);
    expect(formatScoreFailures(two)).toContain('2 categories below the minimum:');
  });
});

describe('serveBuild', () => {
  let dist = '';
  let server: RunningServer;
  const index = '<!doctype html><title>index</title>'.repeat(40);
  const script = 'console.log("hello");'.repeat(100);

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'stuffcloud-serve-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), index);
    writeFileSync(join(dist, 'assets', 'app-a.js'), script);
    writeFileSync(join(dist, 'assets', 'font-a.woff2'), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(dist, 'assets', 'data.bin'), Buffer.from([9]));
    writeFileSync(join(dist, 'robots.txt'), 'static file');
    mkdirSync(join(dist, 'folder'));
    server = await serveBuild(dist);
  });

  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  interface Reply {
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: Buffer;
  }

  function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
    const { port } = new URL(server.url);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('listens on a loopback port and is addressed as localhost, which a browser treats as secure', () => {
    expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  it('serves the index at / and for routes of the app, never cached', async () => {
    for (const path of ['/', '/tools/qr', '/some/deep/link', '/folder']) {
      const reply = await get(path);
      expect(reply.status, path).toBe(200);
      expect(reply.body.toString(), path).toBe(index);
      expect(reply.headers['content-type'], path).toBe('text/html; charset=utf-8');
      expect(reply.headers['cache-control'], path).toBe('no-cache');
    }
  });

  it('gzips text when asked, and the body decodes to the file', async () => {
    const reply = await get('/assets/app-a.js', { 'Accept-Encoding': 'gzip, deflate' });
    expect(reply.headers['content-encoding']).toBe('gzip');
    expect(reply.headers['vary']).toBe('Accept-Encoding');
    expect(reply.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(reply.headers['content-length']).toBe(String(reply.body.length));
    expect(reply.body.length).toBe(gzipSync(script, { level: 9 }).length);
    expect(gunzipSync(reply.body).toString()).toBe(script);
  });

  it('sends text as it is without Accept-Encoding: gzip', async () => {
    for (const encoding of [{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'br' }]) {
      const reply = await get('/assets/app-a.js', encoding);
      expect(reply.headers['content-encoding']).toBeUndefined();
      expect(reply.headers['vary']).toBe('Accept-Encoding');
      expect(reply.body.toString()).toBe(script);
    }
  });

  it('caches hashed assets for good, other files not at all', async () => {
    expect((await get('/assets/app-a.js')).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((await get('/robots.txt')).headers['cache-control']).toBe('no-cache');
    expect((await get('/robots.txt')).body.toString()).toBe('static file');
  });

  it('does not compress what is compressed already, and labels unknown types as bytes', async () => {
    const font = await get('/assets/font-a.woff2', { 'Accept-Encoding': 'gzip' });
    expect(font.headers['content-encoding']).toBeUndefined();
    expect(font.headers['vary']).toBeUndefined();
    expect(font.headers['content-type']).toBe('font/woff2');
    expect([...font.body]).toEqual([1, 2, 3, 4]);
    const bin = await get('/assets/data.bin');
    expect(bin.headers['content-type']).toBe('application/octet-stream');
    expect(bin.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers a missing asset with 404, not with the page', async () => {
    const reply = await get('/assets/gone-a.js');
    expect(reply.status).toBe(404);
    expect(reply.body.toString()).toBe('Not found');
  });

  it('does not leave the build directory', async () => {
    const outside = `${dist}-outside.txt`;
    writeFileSync(outside, 'outside the build');
    try {
      const name = outside.slice(outside.lastIndexOf(sep) + 1);
      for (const path of [`/..%2f${name}`, `/assets/..%2f..%2f${name}`, `/%2e%2e%2f${name}`]) {
        const reply = await get(path);
        expect(reply.status, path).toBe(404);
        expect(reply.body.toString(), path).not.toContain('outside the build');
      }
    } finally {
      rmSync(outside, { force: true });
    }
    // Dot segments the URL parser resolves itself stay inside the build: the index (a route of the app).
    expect((await get('/%2e%2e/%2e%2e/etc/passwd')).body.toString()).toBe(index);
  });

  it('refuses a malformed path', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await get('/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(index)));
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const reply = await get('/', {}, method);
      expect(reply.status, method).toBe(405);
      expect(reply.headers['allow']).toBe('GET, HEAD');
    }
  });

  it('answers 500 when a file cannot be read', async () => {
    rmSync(join(dist, 'index.html'));
    expect((await get('/')).status).toBe(500);
    writeFileSync(join(dist, 'index.html'), index);
  });
});

describe('serveBuild lifecycle', () => {
  it('stops listening on close, and fails to start on a missing build only when asked for a file', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'stuffcloud-serve-'));
    const server = await serveBuild(dist);
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
    rmSync(dist, { recursive: true, force: true });
  });
});
