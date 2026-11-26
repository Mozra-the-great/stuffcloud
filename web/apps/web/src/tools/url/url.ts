/**
 * URL encoding, decoding and parsing with the browser's own functions (`encodeURIComponent`, `URL`).
 * Nothing here opens, follows or requests a URL: it only reads the text.
 */

export type EncodeMode = 'component' | 'uri' | 'form';
export const MODES: readonly EncodeMode[] = ['component', 'uri', 'form'];

/** Longest text the tool works on; a URL longer than this is not a URL anyone types. */
export const MAX_LENGTH = 100_000;

export type EncodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: 'surrogate' };

export type DecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: 'malformed'; readonly index: number };

/** The characters `encodeURIComponent` leaves alone but a form submission (`application/x-www-form-urlencoded`) encodes. */
const FORM_EXTRA = /[!'()~]/g;

function percent(char: string): string {
  // Only the ASCII characters of FORM_EXTRA come here (0x21 to 0x7e): always two hex digits.
  return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
}

/** Percent-encodes `text` as UTF-8. A lone surrogate half cannot be encoded as UTF-8 and is an error. */
export function encodeText(text: string, mode: EncodeMode): EncodeResult {
  try {
    if (mode === 'uri') {
      return { ok: true, text: encodeURI(text) };
    }
    const encoded = encodeURIComponent(text);
    return {
      ok: true,
      text: mode === 'form' ? encoded.replace(FORM_EXTRA, percent).replaceAll('%20', '+') : encoded,
    };
  } catch {
    return { ok: false, error: 'surrogate' };
  }
}

// Tested on a slice of at most two characters, so the pattern needs no anchors.
const HEX_PAIR = /[0-9a-fA-F]{2}/;

function decodeWith(mode: EncodeMode, text: string): string {
  return mode === 'uri' ? decodeURI(text) : decodeURIComponent(text);
}

/**
 * Decodes percent sequences as UTF-8; in form mode a `+` is a space. A `%` without two hex digits, or a
 * run of `%XX` that is not valid UTF-8, is reported with the place where it starts. The text is decoded
 * run by run and the results are used, so that a build tool cannot drop the calls that signal the error
 * by throwing.
 */
export function decodeText(text: string, mode: EncodeMode): DecodeResult {
  const source = mode === 'form' ? text.replaceAll('+', ' ') : text;
  let decoded = '';
  let index = 0;
  for (;;) {
    const next = source.indexOf('%', index);
    if (next < 0) {
      return { ok: true, text: decoded + source.slice(index) };
    }
    decoded += source.slice(index, next);
    index = next;
    // A run of escapes: each is a percent sign and two hex digits. The percent sign must be checked too, or
    // the run would hop over plain text that looks like hex digits and report the wrong start.
    while (source[index] === '%' && HEX_PAIR.test(source.slice(index + 1, index + 3))) {
      index += 3;
    }
    if (index === next) {
      return { ok: false, error: 'malformed', index: next };
    }
    try {
      decoded += decodeWith(mode, source.slice(next, index));
    } catch {
      return { ok: false, error: 'malformed', index: next };
    }
  }
}

export interface QueryParam {
  readonly name: string;
  readonly value: string;
}

export interface ParsedUrl {
  /** The URL as the browser writes it back (lowercase scheme and host, `/` for an empty path, ...). */
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  /** The port written in the URL; empty when it is absent or the default of the scheme. */
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly origin: string;
  /** The query as name and value pairs, decoded (`+` is a space), in order, repeats kept. */
  readonly params: readonly QueryParam[];
}

export type ParseResult =
  | { readonly ok: true; readonly url: ParsedUrl }
  | { readonly ok: false; readonly error: 'empty' | 'invalid' };

/** Reads an absolute URL the way a browser does; a relative one or plain text is `invalid`. */
export function parseUrl(input: string): ParseResult {
  const text = input.trim();
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  return {
    ok: true,
    url: {
      href: url.href,
      protocol: url.protocol,
      username: url.username,
      password: url.password,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      // `origin` is the string "null" for schemes without one (data:, mailto:, ...).
      origin: url.origin,
      params: Array.from(url.searchParams, ([name, value]) => ({ name, value })),
    },
  };
}
