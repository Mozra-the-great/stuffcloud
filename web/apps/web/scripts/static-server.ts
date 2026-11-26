import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

// Serves a production build the way the Caddyfile does (docker/caddy/Caddyfile.dev, section "The
// app"): gzip for text, hashed files under /assets/ cached for good, every other path falls back to
// the index page (ADR 0011) and is never cached. `vite preview` does none of the compression, and the
// transfer sizes it would report make Lighthouse's simulated throttling pessimistic compared with what a
// visitor of the real server gets. Used by the Lighthouse gate (T-25, #29); GET and HEAD only.

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const INDEX_TYPE = 'text/html; charset=utf-8';

/** Types that compress well; fonts and images are already compressed. */
function compressible(type: string): boolean {
  return /^(?:text\/|application\/(?:json|wasm)|image\/svg)/.test(type);
}

export interface RunningServer {
  /** `http://localhost:<port>/`: Lighthouse and the browser treat `localhost` as a secure origin, as the HTTPS of a real instance is. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface Resolved {
  readonly path: string;
  readonly type: string;
  readonly cache: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolveRequest(root: string, pathname: string): Promise<Resolved | undefined> {
  const index: Resolved = { path: join(root, 'index.html'), type: INDEX_TYPE, cache: 'no-cache' };
  if (pathname === '/') {
    return index;
  }
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root + sep)) {
    return undefined;
  }
  const assets = pathname.startsWith('/assets/');
  if (await isFile(path)) {
    return {
      path,
      type: TYPES[extname(path)] ?? 'application/octet-stream',
      cache: assets ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
  }
  // A missing asset is a 404, not a page of HTML; any other path is a route of the app.
  return assets ? undefined : index;
}

async function respond(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const found = await resolveRequest(root, pathname);
  if (found === undefined) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  let body = await readFile(found.path);
  const headers: Record<string, string> = {
    'Content-Type': found.type,
    'Cache-Control': found.cache,
    'X-Content-Type-Options': 'nosniff',
  };
  if (compressible(found.type)) {
    headers['Vary'] = 'Accept-Encoding';
    if (/\bgzip\b/.test(request.headers['accept-encoding'] ?? '')) {
      body = gzipSync(body, { level: 9 });
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = String(body.length);
  response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : body);
}

/** Starts the server for the build in `dist` on a free port of the loopback interface. */
export async function serveBuild(dist: string): Promise<RunningServer> {
  const root = resolve(dist);
  const server: Server = createServer((request, response) => {
    respond(root, request, response).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${String(port)}/`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => {
          if (error === undefined) {
            done();
          } else {
            fail(error);
          }
        });
        server.closeAllConnections();
      }),
  };
}
