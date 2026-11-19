/**
 * Base64 of our own, byte for byte (RFC 4648), so that it can report exactly where a text is wrong,
 * read both alphabets, take a data URI and cope with a file of tens of megabytes. It must not
 * touch the DOM (it runs in a worker for files).
 */

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function table(alphabet: string): Uint8Array {
  return Uint8Array.from(alphabet, (char) => char.charCodeAt(0));
}

const ENCODE_STANDARD = table(STANDARD);
const ENCODE_URL_SAFE = table(URL_SAFE);

/** Longest text the page encodes or decodes without a file. */
export const MAX_TEXT_CHARS = 2_000_000;
/** Largest file to encode (the text is a third longer, and has to fit in memory twice). */
export const MAX_FILE_BYTES = 48 * 1024 * 1024;
/** Longest Base64 text of a file to decode, in bytes. */
export const MAX_DECODE_FILE_BYTES = 64 * 1024 * 1024;

export interface EncodeOptions {
  readonly urlSafe: boolean;
  /** Add the `=` that makes the text a multiple of four characters. */
  readonly padding: boolean;
  /** A line break after this many characters; 0 for none. */
  readonly lineLength: 0 | 64 | 76;
}

/** Base64 of `bytes`. */
export function encodeBytes(bytes: Uint8Array, options: EncodeOptions): string {
  const alphabet = options.urlSafe ? ENCODE_URL_SAFE : ENCODE_STANDARD;
  const full = Math.floor(bytes.length / 3);
  const rest = bytes.length - full * 3;
  const length = full * 4 + (rest === 0 ? 0 : options.padding ? 4 : rest + 1);
  const out = new Uint8Array(length);
  let source = 0;
  let target = 0;
  const at = (index: number): number => alphabet[index] ?? 0;
  for (let group = 0; group < full; group += 1) {
    const value =
      ((bytes[source] ?? 0) << 16) | ((bytes[source + 1] ?? 0) << 8) | (bytes[source + 2] ?? 0);
    out[target] = at(value >> 18);
    out[target + 1] = at((value >> 12) & 63);
    out[target + 2] = at((value >> 6) & 63);
    out[target + 3] = at(value & 63);
    source += 3;
    target += 4;
  }
  if (rest === 1) {
    const value = (bytes[source] ?? 0) << 16;
    out[target] = at(value >> 18);
    out[target + 1] = at((value >> 12) & 63);
    if (options.padding) {
      out[target + 2] = 61;
      out[target + 3] = 61;
    }
  } else if (rest === 2) {
    const value = ((bytes[source] ?? 0) << 16) | ((bytes[source + 1] ?? 0) << 8);
    out[target] = at(value >> 18);
    out[target + 1] = at((value >> 12) & 63);
    out[target + 2] = at((value >> 6) & 63);
    if (options.padding) {
      out[target + 3] = 61;
    }
  }
  return wrapLines(new TextDecoder().decode(out), options.lineLength);
}

/** `text` with a line break after every `length` characters (none for 0). */
export function wrapLines(text: string, length: number): string {
  if (length === 0) {
    return text;
  }
  const lines: string[] = [];
  for (let start = 0; start < text.length; start += length) {
    lines.push(text.slice(start, start + length));
  }
  return lines.join(String.fromCharCode(10));
}

/** A data URI: `data:<media type>;base64,<text>`. */
export function dataUri(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

const MEDIA_TYPE =
  /^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:;[\w!#$&^.+-]+=(?:[\w!#$&^.+-]+|"[^"\r\n]*"))*$/;

/** Whether `text` is a media type such as `text/plain;charset=utf-8`. */
export function isMediaType(text: string): boolean {
  return MEDIA_TYPE.test(text);
}

export type DecodeErrorCode =
  'empty' | 'invalidChar' | 'badLength' | 'badPadding' | 'mixedAlphabet' | 'notBase64DataUri';

export interface DecodeError {
  readonly code: DecodeErrorCode;
  /** Offset in the text of what is wrong. */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  /** The character at fault. */
  readonly found?: string;
}

export type Decoded =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** The media type a data URI named, if the text was one. */
      readonly mediaType?: string;
    }
  | { readonly ok: false; readonly error: DecodeError };

const DATA_URI = /^\s*data:([^,]*?)(;base64)?,/i;

function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || (code === 13 && text.charCodeAt(index + 1) !== 10)) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** The value of each Base64 character in the two alphabets: 0 to 63, 64 for `=`, 255 for none. */
const VALUES = new Uint8Array(128).fill(255);
STANDARD.split('').forEach((char, value) => {
  VALUES[char.charCodeAt(0)] = value;
});
VALUES['-'.charCodeAt(0)] = 62;
VALUES['_'.charCodeAt(0)] = 63;
VALUES['='.charCodeAt(0)] = 64;

/**
 * Decodes Base64 text. It reads the standard and the URL-safe alphabet (but not both in one text),
 * ignores white space, does not need the `=` padding, and understands a `data:...;base64,` prefix.
 * Never throws: a problem comes back with its position.
 */
export function decodeBase64(source: string): Decoded {
  const fail = (code: DecodeErrorCode, offset: number, found?: string): Decoded => ({
    ok: false,
    error: {
      code,
      offset,
      ...locate(source, offset),
      ...(found === undefined ? {} : { found }),
    },
  });
  let start = 0;
  let mediaType: string | undefined;
  const uri = DATA_URI.exec(source);
  if (uri !== null) {
    if (uri[2] === undefined) {
      return fail('notBase64DataUri', 0);
    }
    start = uri[0].length;
    mediaType = (uri[1] ?? '').trim() === '' ? undefined : (uri[1] ?? '').trim();
  }
  const out = new Uint8Array(Math.ceil(((source.length - start) * 3) / 4) + 3);
  let produced = 0;
  let bits = 0;
  let held = 0;
  let characters = 0;
  let padding = 0;
  let paddingAt = -1;
  let alphabet: 'standard' | 'url' | undefined;
  for (let index = start; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      continue;
    }
    const value = code < 128 ? (VALUES[code] ?? 255) : 255;
    if (value === 255) {
      return fail('invalidChar', index, String.fromCodePoint(source.codePointAt(index) ?? code));
    }
    if (value === 64) {
      if (padding === 0) {
        paddingAt = index;
      }
      padding += 1;
      continue;
    }
    if (padding > 0) {
      // Data after the `=`.
      return fail('badPadding', paddingAt);
    }
    if (code === 43 || code === 47 || code === 45 || code === 95) {
      const kind = code === 43 || code === 47 ? 'standard' : 'url';
      if (alphabet !== undefined && alphabet !== kind) {
        return fail('mixedAlphabet', index, source.charAt(index));
      }
      alphabet = kind;
    }
    held = (held << 6) | value;
    bits += 6;
    characters += 1;
    if (bits >= 8) {
      bits -= 8;
      out[produced] = (held >> bits) & 255;
      produced += 1;
      held &= (1 << bits) - 1;
    }
  }
  if (characters === 0 && padding === 0) {
    return fail('empty', source.length);
  }
  if (padding > 2 || (padding > 0 && (characters + padding) % 4 !== 0)) {
    return fail('badPadding', paddingAt);
  }
  if (characters % 4 === 1) {
    return fail('badLength', source.length);
  }
  return {
    ok: true,
    bytes: out.slice(0, produced),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

/** Whether `text` has a control character other than the usual white space: a sign of a binary file. */
function hasBinaryControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) {
      return true;
    }
  }
  return false;
}

/** The bytes as text when they are valid UTF-8 (and not a binary file), or `undefined`. */
export function asText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return hasBinaryControl(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/** `89 50 4e 47`: the first bytes in hexadecimal. */
export function hexHead(bytes: Uint8Array, count = 16): string {
  return [...bytes.slice(0, count)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

/** Types a browser runs or renders when the file is opened: decoded data is never saved under one of these. */
const ACTIVE_TYPES =
  /^(?:text\/(?:html|xml|javascript)|application\/(?:xhtml\+xml|xml|javascript)|image\/svg\+xml)$/;

function baseType(mediaType: string | undefined): string {
  return (mediaType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The type decoded data is saved with: the one a data URI named when it is harmless, else plain
 * text or an opaque binary type (a data URI of an attacker must not turn into an HTML or SVG file).
 */
export function downloadType(mediaType: string | undefined, isText: boolean): string {
  const type = baseType(mediaType);
  if (type !== '' && !ACTIVE_TYPES.test(type)) {
    return mediaType ?? '';
  }
  return isText ? 'text/plain' : 'application/octet-stream';
}

/** A file name for decoded data: by its media type when it is a well-known, harmless one, else `bin` or `txt`. */
export function decodedFileName(mediaType: string | undefined, isText: boolean): string {
  const type = baseType(mediaType);
  const extension = ACTIVE_TYPES.test(type) ? undefined : EXTENSIONS[type];
  return `decoded.${extension ?? (isText ? 'txt' : 'bin')}`;
}
