import { formatAddress } from '../subnet/ip.ts';

/**
 * MAC addresses (EUI-48 and EUI-64): reading the common spellings, writing them, and the two flag
 * bits of the first byte. No vendor data is in here: a vendor name only comes from a list the visitor
 * loads (`oui.ts`). Pure: no DOM, no I/O.
 */

/** Longest address text that is read. */
export const MAX_MAC_LENGTH = 40;
/** Most addresses one input holds. */
export const MAX_ADDRESSES = 1000;
/** Longest input, in characters. */
export const MAX_INPUT_LENGTH = 100_000;

export interface Mac {
  /** 6 bytes (EUI-48) or 8 bytes (EUI-64). */
  readonly bytes: readonly number[];
}

export type MacErrorCode = 'empty' | 'too-long' | 'characters' | 'separators' | 'group' | 'length';

export type MacResult =
  { readonly ok: true; readonly mac: Mac } | { readonly ok: false; readonly error: MacErrorCode };

const HEX = /^[0-9a-fA-F]+$/;

function fromHex(digits: string): number[] {
  const bytes: number[] = [];
  for (let at = 0; at < digits.length; at += 2) {
    bytes.push(Number.parseInt(digits.slice(at, at + 2), 16));
  }
  return bytes;
}

function bytesOrLength(bytes: number[]): MacResult {
  return bytes.length === 6 || bytes.length === 8
    ? { ok: true, mac: { bytes } }
    : { ok: false, error: 'length' };
}

/**
 * Reads `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, `aabb.ccdd.eeff`, `aabbccddeeff`, `aabb-ccdd-eeff` and
 * the form some systems print without leading zeros (`0:1:2:a:b:c`); 12 or 16 hex digits.
 */
export function parseMac(input: string): MacResult {
  const text = input.trim();
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  if (text.length > MAX_MAC_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  const separators = new Set(text.match(/[:.-]/g));
  if (separators.size > 1) {
    return { ok: false, error: 'separators' };
  }
  if (separators.size === 0) {
    if (!HEX.test(text)) {
      return { ok: false, error: 'characters' };
    }
    return bytesOrLength(text.length % 2 === 0 ? fromHex(text) : []);
  }
  const separator = [...separators][0] ?? ':';
  const parts = text.split(separator);
  if (parts.some((part) => !HEX.test(part) && part !== '')) {
    return { ok: false, error: 'characters' };
  }
  if (parts.some((part) => part === '')) {
    return { ok: false, error: 'group' };
  }
  if (separator === '.' || parts.every((part) => part.length === 4)) {
    // Groups of four digits: `aabb.ccdd.eeff` (three or four groups).
    if (parts.some((part) => part.length !== 4)) {
      return { ok: false, error: 'group' };
    }
    return bytesOrLength(fromHex(parts.join('')));
  }
  if (parts.some((part) => part.length > 2)) {
    return { ok: false, error: 'group' };
  }
  return bytesOrLength(parts.map((part) => Number.parseInt(part, 16)));
}

export type MacStyle =
  'colon-lower' | 'colon-upper' | 'dash-upper' | 'dot-lower' | 'bare-lower' | 'bare-upper';

export const MAC_STYLES: readonly MacStyle[] = [
  'colon-lower',
  'colon-upper',
  'dash-upper',
  'dot-lower',
  'bare-lower',
  'bare-upper',
];

function hex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The address in one of the usual spellings. */
export function formatMac(mac: Mac, style: MacStyle): string {
  const digits = hex(mac.bytes);
  const pairs = mac.bytes.map((byte) => byte.toString(16).padStart(2, '0'));
  switch (style) {
    case 'colon-lower':
      return pairs.join(':');
    case 'colon-upper':
      return pairs.join(':').toUpperCase();
    case 'dash-upper':
      return pairs.join('-').toUpperCase();
    case 'dot-lower':
      return (digits.match(/.{4}/g) ?? []).join('.');
    case 'bare-lower':
      return digits;
    case 'bare-upper':
      return digits.toUpperCase();
  }
}

export type MacNote = 'broadcast' | 'ipv4-multicast' | 'ipv6-multicast';

export interface MacBits {
  /** EUI-48 or EUI-64. */
  readonly kind: 'EUI-48' | 'EUI-64';
  /** The group bit (least significant bit of the first byte): 1 is a multicast or broadcast address. */
  readonly multicast: boolean;
  /** The local bit (second bit of the first byte): 1 is locally administered (not assigned by IEEE). */
  readonly local: boolean;
  readonly note: MacNote | undefined;
  /** The three bytes that name the vendor of a universally administered address, as `AA-BB-CC`. */
  readonly oui: string;
}

/** The two flag bits of the first byte, and the multicast ranges that have a name. */
export function describeMac(mac: Mac): MacBits {
  const [first = 0, second = 0, third = 0, fourth = 0] = mac.bytes;
  const multicast = (first & 0x01) !== 0;
  let note: MacNote | undefined;
  if (mac.bytes.length === 6 && mac.bytes.every((byte) => byte === 0xff)) {
    note = 'broadcast';
  } else if (first === 0x01 && second === 0x00 && third === 0x5e && fourth < 0x80) {
    note = 'ipv4-multicast';
  } else if (first === 0x33 && second === 0x33) {
    note = 'ipv6-multicast';
  }
  return {
    kind: mac.bytes.length === 6 ? 'EUI-48' : 'EUI-64',
    multicast,
    local: (first & 0x02) !== 0,
    note,
    oui: hex(mac.bytes.slice(0, 3))
      .toUpperCase()
      .replace(/(..)(?=.)/g, '$1-'),
  };
}

/**
 * The IPv6 link-local address that SLAAC built from this address before privacy extensions
 * (modified EUI-64, RFC 4291 appendix A): `ff:fe` in the middle of an EUI-48, the local bit flipped.
 */
export function linkLocalAddress(mac: Mac): string {
  const bytes =
    mac.bytes.length === 6
      ? [...mac.bytes.slice(0, 3), 0xff, 0xfe, ...mac.bytes.slice(3)]
      : [...mac.bytes];
  bytes[0] = (bytes[0] ?? 0) ^ 0x02;
  let identifier = 0n;
  for (const byte of bytes) {
    identifier = (identifier << 8n) | BigInt(byte);
  }
  return formatAddress({ version: 6, value: (0xfe80n << 112n) | identifier });
}

export type ListedLine =
  | { readonly line: number; readonly text: string; readonly mac: Mac }
  | { readonly line: number; readonly text: string; readonly error: MacErrorCode };

export type ListResult =
  | { readonly ok: true; readonly lines: readonly ListedLine[] }
  | { readonly ok: false; readonly error: 'too-long' | 'too-many' };

/** One address per line (empty lines are skipped); every line is read on its own. */
export function parseMacList(text: string): ListResult {
  if (text.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  const lines: ListedLine[] = [];
  for (const [index, raw] of text.split(/\r\n|\r|\n/).entries()) {
    const entry = raw.trim();
    if (entry === '') {
      continue;
    }
    if (lines.length >= MAX_ADDRESSES) {
      return { ok: false, error: 'too-many' };
    }
    const parsed = parseMac(entry);
    lines.push(
      parsed.ok
        ? { line: index + 1, text: entry, mac: parsed.mac }
        : { line: index + 1, text: entry, error: parsed.error },
    );
  }
  return { ok: true, lines };
}
