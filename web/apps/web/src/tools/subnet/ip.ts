/**
 * IPv4 and IPv6 addresses as `bigint` (32 and 128 bits): reading, writing and the bit helpers the
 * subnet calculator is built on. Own implementation, no dependency. Pure: no DOM, no I/O.
 */

export type IpVersion = 4 | 6;

export interface Address {
  readonly version: IpVersion;
  /** The address as an unsigned integer of 32 (IPv4) or 128 (IPv6) bits. */
  readonly value: bigint;
}

/** Longest address text that is read (the longest IPv6 form with an embedded IPv4 is 45 characters). */
export const MAX_ADDRESS_LENGTH = 64;

export const BITS: Readonly<Record<IpVersion, number>> = { 4: 32, 6: 128 };

export type AddressErrorCode =
  | 'empty'
  | 'too-long'
  | 'characters'
  | 'ipv4-octets'
  | 'ipv4-range'
  | 'ipv4-zero'
  | 'ipv6-zone'
  | 'ipv6-colons'
  | 'ipv6-groups'
  | 'ipv6-group'
  | 'ipv6-ipv4';

export type AddressResult =
  | { readonly ok: true; readonly address: Address }
  | { readonly ok: false; readonly error: AddressErrorCode };

/** `::ffff:0:0/96`: the IPv4-mapped IPv6 addresses (RFC 4291, section 2.5.5.2). */
const MAPPED_PREFIX = 0xffffn << 32n;
const LOW_32 = 0xffff_ffffn;

/** All ones in `bits` bits. */
export function ones(bits: number): bigint {
  return (1n << BigInt(bits)) - 1n;
}

/** The number of bits needed to write `value` (0 for 0). */
export function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

type V4Result =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly error: AddressErrorCode };

function parseV4(text: string): V4Result {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return { ok: false, error: 'ipv4-octets' };
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return { ok: false, error: part === '' ? 'ipv4-octets' : 'characters' };
    }
    if (part.length > 1 && part.startsWith('0')) {
      // "010" is 8 to some tools and 10 to others; refuse it instead of guessing.
      return { ok: false, error: 'ipv4-zero' };
    }
    const octet = Number(part);
    if (octet > 255) {
      return { ok: false, error: 'ipv4-range' };
    }
    value = (value << 8n) | BigInt(octet);
  }
  return { ok: true, value };
}

function parseV6(text: string): V4Result {
  if (text.includes('%')) {
    return { ok: false, error: 'ipv6-zone' };
  }
  if (!/^[0-9a-fA-F:.]+$/.test(text)) {
    return { ok: false, error: 'characters' };
  }
  let body = text;
  if (body.includes('.')) {
    // Only the last 32 bits may be written as an IPv4 address ("::ffff:192.0.2.1").
    const cut = body.lastIndexOf(':');
    const tail = body.slice(cut + 1);
    const embedded = parseV4(tail);
    if (!embedded.ok || body.slice(0, cut + 1).includes('.')) {
      return { ok: false, error: 'ipv6-ipv4' };
    }
    const high = (embedded.value >> 16n).toString(16);
    const low = (embedded.value & 0xffffn).toString(16);
    body = `${body.slice(0, cut + 1)}${high}:${low}`;
  }
  // Three colons in a row need no check of their own: they leave an empty group (or a third `::`) below.
  const halves = body.split('::');
  if (halves.length > 2) {
    return { ok: false, error: 'ipv6-colons' };
  }
  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  // Stryker disable next-line StringLiteral: `split` always returns at least one piece, so the fallback is never used
  const head = split(halves[0] ?? '');
  const tail = split(halves[1] ?? '');
  const groups = [...head, ...tail];
  if (groups.some((group) => group === '')) {
    return { ok: false, error: 'ipv6-colons' };
  }
  if (groups.some((group) => group.length > 4)) {
    return { ok: false, error: 'ipv6-group' };
  }
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) {
    return { ok: false, error: 'ipv6-groups' };
  }
  const fill = 8 - groups.length;
  // Without `::` the check above leaves exactly eight groups, so `fill` is 0 there.
  const full = [...head, ...Array.from({ length: fill }, () => '0'), ...tail];
  let value = 0n;
  for (const group of full) {
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return { ok: true, value };
}

/** Reads an IPv4 address ("192.0.2.1") or an IPv6 address ("2001:db8::1", "::ffff:192.0.2.1"). */
export function parseAddress(input: string): AddressResult {
  const text = input.trim();
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  if (text.length > MAX_ADDRESS_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  if (text.includes(':')) {
    const parsed = parseV6(text);
    return parsed.ok
      ? { ok: true, address: { version: 6, value: parsed.value } }
      : { ok: false, error: parsed.error };
  }
  const parsed = parseV4(text);
  return parsed.ok
    ? { ok: true, address: { version: 4, value: parsed.value } }
    : { ok: false, error: parsed.error };
}

/** `192.0.2.1`. */
export function formatV4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

/** The eight groups of an IPv6 address, as numbers. */
function groupsOf(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(112 - 16 * index)) & 0xffffn),
  );
}

/** Is this an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)? */
export function isMapped(address: Address): boolean {
  // An IPv4 value has no bit above bit 31, so only an IPv6 address can match.
  return address.value >> 32n === 0xffffn;
}

/**
 * IPv6 in the form of RFC 5952: lower case, no leading zeros, the longest run of zero groups (two or
 * more, the first on a tie) as `::`; an IPv4-mapped address keeps its dotted tail (`::ffff:192.0.2.1`).
 */
export function formatV6(value: bigint): string {
  if (value >> 32n === 0xffffn) {
    return `::ffff:${formatV4(value & LOW_32)}`;
  }
  const groups = groupsOf(value);
  let bestStart = 0;
  let bestLength = 0;
  let runStart = 0;
  let runLength = 0;
  groups.forEach((group, index) => {
    if (group !== 0) {
      runLength = 0;
      return;
    }
    if (runLength === 0) {
      runStart = index;
    }
    runLength += 1;
    // Strictly longer: on a tie the first run keeps the `::`.
    if (runLength > bestLength) {
      bestStart = runStart;
      bestLength = runLength;
    }
  });
  const hex = (list: readonly number[]): string =>
    list.map((group) => group.toString(16)).join(':');
  if (bestLength < 2) {
    return hex(groups);
  }
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/** `2001:0db8:0000:0000:0000:0000:0000:0001`: all eight groups, four digits each. */
export function expandV6(value: bigint): string {
  return groupsOf(value)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':');
}

export function formatAddress(address: Address): string {
  return address.version === 4 ? formatV4(address.value) : formatV6(address.value);
}

/** An IPv4 address as the IPv6 address `::ffff:a.b.c.d`. */
export function toMapped(address: Address): Address {
  return { version: 6, value: MAPPED_PREFIX | address.value };
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, or `undefined`. */
export function fromMapped(address: Address): Address | undefined {
  return isMapped(address) ? { version: 4, value: address.value & LOW_32 } : undefined;
}
