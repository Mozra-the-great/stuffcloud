import type { BrowserContext, Page, Request, WebSocket } from '@playwright/test';

/** What the privacy test remembers of a request: only what left the page, never the answer. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | null;
}

export type Rule = 'origin' | 'method' | 'body' | 'path' | 'query' | 'content' | 'websocket';

export interface Violation {
  readonly rule: Rule;
  readonly url: string;
  readonly detail: string;
}

/** A piece of a file that must not show up in any request, and the form it was looked for in. */
export interface Needle {
  readonly form: string;
  readonly bytes: Buffer;
}

const WINDOW = 24;
const ENCODED_WINDOW = 32;

/** Start, middle and end of something `length` long, for a window of `size`. */
function windows(length: number, size: number): number[] {
  if (length <= size) {
    return [0];
  }
  return [...new Set([0, Math.floor((length - size) / 2), length - size])];
}

/**
 * What to look for when a file must not leave the page: windows (start, middle, end) of the
 * bytes as they are, as hex, as base64 and base64url (all three alignments, since a chunk may
 * start anywhere in the file) and as `%XX` escapes. A file shorter than a window is searched whole.
 */
export function fileNeedles(file: Buffer): Needle[] {
  if (file.length === 0) {
    throw new RangeError('an empty file has nothing to look for');
  }
  const needles: Needle[] = [];
  for (const at of windows(file.length, WINDOW)) {
    const piece = file.subarray(at, at + WINDOW);
    needles.push(
      { form: 'raw', bytes: piece },
      { form: 'hex', bytes: Buffer.from(piece.toString('hex'), 'latin1') },
      {
        form: 'percent',
        bytes: Buffer.from(
          [...piece].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
          'latin1',
        ),
      },
    );
  }
  for (let shift = 0; shift < 3 && shift < file.length; shift += 1) {
    const rest = file.subarray(shift);
    const plain = rest.toString('base64').replace(/=+$/, '');
    const urlSafe = rest.toString('base64url');
    for (const at of windows(plain.length, ENCODED_WINDOW)) {
      const piece = plain.slice(at, at + ENCODED_WINDOW);
      needles.push(
        { form: `base64 (shift ${String(shift)})`, bytes: Buffer.from(piece, 'latin1') },
        {
          form: `base64 (shift ${String(shift)}), percent-escaped`,
          bytes: Buffer.from(encodeURIComponent(piece), 'latin1'),
        },
        {
          form: `base64url (shift ${String(shift)})`,
          bytes: Buffer.from(urlSafe.slice(at, at + ENCODED_WINDOW), 'latin1'),
        },
      );
    }
  }
  return needles;
}

/** Prefix of every file the build emits (`assets/<name>-<hash>.<ext>`). */
export const ASSET_PREFIX = '/assets/';

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The rules of the privacy test for one request, against the origin of the app:
 * - `data:` and `blob:` never leave the browser and are ignored;
 * - `origin`: nothing goes to another origin, with or without a body;
 * - `method`: only `GET` and `HEAD`;
 * - `body`: no request body at all;
 * - `path` / `query`: apart from the page itself (a document), a request is one of the app's own
 *   assets, `/assets/<file>` without a query string, so loading an asset cannot carry data;
 * - `content`: no needle (a piece of a watched file, in any encoding) in the URL, the headers
 *   or the body.
 * Every request is checked against every rule, so a leak reports every way it was caught.
 */
export function inspect(
  request: RecordedRequest,
  appOrigin: string,
  needles: readonly Needle[] = [],
): Violation[] {
  const url = new URL(request.url);
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    return [];
  }
  const found: Violation[] = [];
  const add = (rule: Rule, detail: string): void => {
    found.push({ rule, url: request.url.slice(0, 160), detail });
  };
  if (url.origin !== appOrigin) {
    add('origin', `${url.origin} is not ${appOrigin}`);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    add('method', `${request.method} request`);
  }
  if (request.body !== null && request.body.length > 0) {
    add('body', `${String(request.body.length)} bytes of body`);
  }
  if (request.resourceType !== 'document') {
    if (!url.pathname.startsWith(ASSET_PREFIX)) {
      add('path', `${url.pathname} is not under ${ASSET_PREFIX}`);
    } else if (url.search !== '') {
      add(
        'query',
        `an asset request carries a query string of ${String(url.search.length)} characters`,
      );
    }
  }
  const haystack = Buffer.concat([
    Buffer.from(request.url, 'latin1'),
    Buffer.from(decoded(request.url), 'latin1'),
    Buffer.from(JSON.stringify(request.headers), 'latin1'),
    request.body ?? Buffer.alloc(0),
  ]);
  const hit = needles.find((needle) => haystack.includes(needle.bytes));
  if (hit !== undefined) {
    add('content', `file content found (${hit.form})`);
  }
  return found;
}

/**
 * Hosts whose requests are left out of the record, from `E2E_IGNORE_HOSTS` (comma separated; a
 * host also covers its subdomains). Empty by default and never set in CI: it exists for a
 * developer machine whose security software injects its own traffic into the browser, which
 * would otherwise turn every run red. Anything the app itself sends still counts.
 */
export function ignoredHosts(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
}

/** Whether `hostname` is one of `hosts` or a subdomain of one. */
export function isIgnoredHost(hostname: string, hosts: readonly string[]): boolean {
  const name = hostname.toLowerCase();
  return hosts.some((host) => name === host || name.endsWith(`.${host}`));
}

/** Formats violations for an assertion message. */
export function describeViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `[${v.rule}] ${v.url} (${v.detail})`).join('\n');
}

/**
 * Records every request of a browser context (pages and their workers: a leak from a worker is
 * still a leak) and every WebSocket, from creation until `dispose`.
 */
export class NetworkRecorder {
  readonly requests: RecordedRequest[] = [];
  readonly sockets: string[] = [];
  readonly #needles: Needle[] = [];
  readonly #appOrigin: string;
  readonly #context: BrowserContext;
  readonly #ignored: readonly string[];
  readonly #onRequest = (request: Request): void => {
    if (isIgnoredHost(new URL(request.url()).hostname, this.#ignored)) {
      return;
    }
    this.requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      body: request.postDataBuffer(),
    });
  };
  readonly #onWebSocket = (socket: WebSocket): void => {
    this.sockets.push(socket.url());
  };
  readonly #onPage = (page: Page): void => {
    page.on('websocket', this.#onWebSocket);
  };

  constructor(
    context: BrowserContext,
    appOrigin: string,
    ignored: readonly string[] = ignoredHosts(process.env['E2E_IGNORE_HOSTS']),
  ) {
    this.#context = context;
    this.#appOrigin = appOrigin;
    this.#ignored = ignored;
    context.on('request', this.#onRequest);
    context.on('page', this.#onPage);
  }

  /** From now on a piece of `file` in any request is a violation. */
  watch(file: Buffer): void {
    this.#needles.push(...fileNeedles(file));
  }

  violations(): Violation[] {
    return [
      ...this.requests.flatMap((request) => inspect(request, this.#appOrigin, this.#needles)),
      ...this.sockets.map((url): Violation => ({
        rule: 'websocket',
        url,
        detail: 'a WebSocket was opened',
      })),
    ];
  }

  /** Throws when anything that left the page broke a rule. */
  assertClean(): void {
    const violations = this.violations();
    if (violations.length > 0) {
      throw new Error(`the page sent something it must not:\n${describeViolations(violations)}`);
    }
  }

  dispose(): void {
    this.#context.off('request', this.#onRequest);
    this.#context.off('page', this.#onPage);
  }
}
