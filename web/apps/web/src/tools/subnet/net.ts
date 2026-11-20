import {
  BITS,
  bitLength,
  formatAddress,
  fromMapped,
  ones,
  parseAddress,
  toMapped,
  type AddressErrorCode,
  type IpVersion,
} from './ip.ts';

/**
 * Networks in CIDR notation on top of `ip.ts`: the numbers of one network, splitting, summarising
 * ranges and networks, and the contains check. Pure: no DOM, no I/O.
 */

/** A network as written: the address (host bits may be set) and the prefix length. */
export interface Network {
  readonly version: IpVersion;
  readonly address: bigint;
  readonly prefix: number;
}

export type NetworkErrorCode = AddressErrorCode | 'slash' | 'prefix' | 'mask';

export type NetworkResult =
  | {
      readonly ok: true;
      readonly network: Network;
      /** Was a prefix length or a mask written? Without one the address is a single host. */
      readonly hadPrefix: boolean;
    }
  | { readonly ok: false; readonly error: NetworkErrorCode };

/** Most subnets a split lists (and the most the page renders). */
export const MAX_SUBNETS = 4096;
/** Most entries the summary reads. */
export const MAX_ENTRIES = 5000;
/** Longest input of the summary, in characters. */
export const MAX_LIST_LENGTH = 200_000;
/** Longest count of subnets that is read, in digits. */
const MAX_COUNT_DIGITS = 40;

/** The mask of a prefix: `prefix` one bits followed by zeros, `bits` wide. */
export function maskOf(prefix: number, bits: number): bigint {
  return ones(bits) ^ ones(bits - prefix);
}

/** `255.255.255.0` as a prefix length, or `undefined` when its ones are not one block from the left. */
function prefixFromMask(mask: bigint): number | undefined {
  const inverted = ones(32) ^ mask;
  if ((inverted & (inverted + 1n)) !== 0n) {
    return undefined;
  }
  return 32 - bitLength(inverted);
}

/**
 * Reads `192.0.2.0/24`, `192.0.2.0/255.255.255.0` (IPv4 only), `2001:db8::/32` or a bare address
 * (a host: `/32` or `/128`).
 */
export function parseNetwork(input: string): NetworkResult {
  const text = input.trim();
  const slash = text.indexOf('/');
  if (slash !== text.lastIndexOf('/')) {
    return { ok: false, error: 'slash' };
  }
  const parsed = parseAddress(slash === -1 ? text : text.slice(0, slash));
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const { version, value } = parsed.address;
  const bits = BITS[version];
  if (slash === -1) {
    return { ok: true, network: { version, address: value, prefix: bits }, hadPrefix: false };
  }
  const suffix = text.slice(slash + 1).trim();
  if (/^(?:0|[1-9]\d{0,2})$/.test(suffix)) {
    const prefix = Number(suffix);
    if (prefix > bits) {
      return { ok: false, error: 'prefix' };
    }
    return { ok: true, network: { version, address: value, prefix }, hadPrefix: true };
  }
  if (version === 4 && suffix.includes('.')) {
    const mask = parseAddress(suffix);
    const prefix =
      mask.ok && mask.address.version === 4 ? prefixFromMask(mask.address.value) : undefined;
    if (prefix === undefined) {
      return { ok: false, error: 'mask' };
    }
    return { ok: true, network: { version, address: value, prefix }, hadPrefix: true };
  }
  return { ok: false, error: 'prefix' };
}

/** The numbers of one network. */
export interface NetworkInfo {
  readonly version: IpVersion;
  readonly prefix: number;
  readonly bits: number;
  /** The address as written. */
  readonly given: bigint;
  /** Host bits were set in the address as written. */
  readonly hostBitsSet: boolean;
  readonly network: bigint;
  /** The highest address of the network (the broadcast address of an IPv4 network of /30 or larger). */
  readonly last: bigint;
  /** IPv4 only, and only where the network has one: not for /31 (RFC 3021) and /32. */
  readonly broadcast: bigint | undefined;
  readonly netmask: bigint;
  readonly wildcard: bigint;
  /** 2^(bits - prefix) addresses. */
  readonly total: bigint;
  readonly firstUsable: bigint;
  readonly lastUsable: bigint;
  /** Addresses that can be given to hosts. */
  readonly usable: bigint;
}

export function describeNetwork(network: Network): NetworkInfo {
  const { version, prefix, address } = network;
  const bits = BITS[version];
  const netmask = maskOf(prefix, bits);
  const wildcard = ones(bits) ^ netmask;
  const first = address & netmask;
  const last = first | wildcard;
  const total = wildcard + 1n;
  // IPv4 keeps the network and broadcast address out, except /31 (point to point, RFC 3021) and /32
  // (one host). IPv6 has no broadcast address: every address of the network is usable (RFC 6164 for /127).
  const trimmed = version === 4 && prefix <= 30;
  return {
    version,
    prefix,
    bits,
    given: address,
    hostBitsSet: address !== first,
    network: first,
    last,
    broadcast: trimmed ? last : undefined,
    netmask,
    wildcard,
    total,
    firstUsable: trimmed ? first + 1n : first,
    lastUsable: trimmed ? last - 1n : last,
    usable: trimmed ? total - 2n : total,
  };
}

/** `192.0.2.0/24`, with the host bits cleared. */
export function formatCidr(version: IpVersion, address: bigint, prefix: number): string {
  const first = address & maskOf(prefix, BITS[version]);
  return `${formatAddress({ version, value: first })}/${String(prefix)}`;
}

/** `2^64` when `total` is a power of two bigger than 1; `undefined` otherwise. */
export function powerOfTwo(total: bigint): string | undefined {
  if (total <= 1n || (total & (total - 1n)) !== 0n) {
    return undefined;
  }
  return `2^${String(bitLength(total) - 1)}`;
}

/** The IPv4 form of a network inside `::ffff:0:0/96` (prefix 96 or more), or `undefined`. */
export function mappedToIpv4(network: Network): Network | undefined {
  if (network.version !== 6 || network.prefix < 96) {
    return undefined;
  }
  const v4 = fromMapped({ version: 6, value: network.address });
  return v4 === undefined
    ? undefined
    : { version: 4, address: v4.value, prefix: network.prefix - 96 };
}

/** The IPv4-mapped IPv6 form of an IPv4 network. */
export function ipv4ToMapped(network: Network): Network {
  return {
    version: 6,
    address: toMapped({ version: 4, value: network.address }).value,
    prefix: network.prefix + 96,
  };
}

/* ---- split ---- */

export type SplitSpec =
  | { readonly by: 'count'; readonly text: string }
  | { readonly by: 'prefix'; readonly text: string };

export type SplitErrorCode = 'empty' | 'number' | 'power' | 'range' | 'too-small' | 'too-many';

export type SplitResult =
  | {
      readonly ok: true;
      readonly prefix: number;
      /** How many subnets there are (the same as `subnets.length`). */
      readonly count: number;
      readonly subnets: readonly Network[];
    }
  | { readonly ok: false; readonly error: SplitErrorCode };

/**
 * Cuts a network into equal subnets: a number of them (a power of two) or the prefix length of each.
 * At most `MAX_SUBNETS`; a bigger split is refused instead of cut off, so the list is always whole.
 */
export function splitNetwork(network: Network, spec: SplitSpec): SplitResult {
  const text = spec.text.trim();
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  const bits = BITS[network.version];
  const room = bits - network.prefix;
  let prefix: number;
  if (spec.by === 'prefix') {
    if (!/^(?:0|[1-9]\d{0,3})$/.test(text)) {
      return { ok: false, error: 'number' };
    }
    prefix = Number(text);
    if (prefix < network.prefix || prefix > bits) {
      return { ok: false, error: 'range' };
    }
  } else {
    if (!/^[1-9]\d*$/.test(text) || text.length > MAX_COUNT_DIGITS) {
      return { ok: false, error: 'number' };
    }
    const count = BigInt(text);
    if ((count & (count - 1n)) !== 0n) {
      return { ok: false, error: 'power' };
    }
    const extra = bitLength(count) - 1;
    if (extra > room) {
      return { ok: false, error: 'too-small' };
    }
    prefix = network.prefix + extra;
  }
  const extra = prefix - network.prefix;
  if (extra > 12) {
    // 2^12 = 4096 = MAX_SUBNETS
    return { ok: false, error: 'too-many' };
  }
  const count = 2 ** extra;
  const first = network.address & maskOf(network.prefix, bits);
  const step = 1n << BigInt(bits - prefix);
  const subnets: Network[] = [];
  for (let index = 0; index < count; index += 1) {
    subnets.push({ version: network.version, address: first + step * BigInt(index), prefix });
  }
  return { ok: true, prefix, count, subnets };
}

/* ---- ranges and summary ---- */

/** The addresses from `start` to `end`, both included. */
export interface Range {
  readonly version: IpVersion;
  readonly start: bigint;
  readonly end: bigint;
}

/** The fewest networks that cover exactly `start` to `end`. */
export function rangeToNetworks(range: Range): Network[] {
  const bits = BITS[range.version];
  const list: Network[] = [];
  let start = range.start;
  while (start <= range.end) {
    // The biggest block that starts at `start` (its alignment) and ends no later than `end`.
    const alignment = start === 0n ? bits : lowestSetBit(start);
    const fit = bitLength(range.end - start + 1n) - 1;
    const size = Math.min(alignment, fit);
    list.push({ version: range.version, address: start, prefix: bits - size });
    start += 1n << BigInt(size);
  }
  return list;
}

function lowestSetBit(value: bigint): number {
  return bitLength(value & -value) - 1;
}

export function networkRange(network: Network): Range {
  const info = describeNetwork(network);
  return { version: network.version, start: info.network, end: info.last };
}

export type EntryErrorCode = NetworkErrorCode | 'range-order' | 'range-version';

export type EntryResult =
  | { readonly ok: true; readonly range: Range }
  | { readonly ok: false; readonly error: EntryErrorCode };

/** One entry of the summary: a network, an address or `start-end` (two addresses of one version). */
export function parseEntry(text: string): EntryResult {
  const dash = text.indexOf('-');
  if (dash === -1) {
    const parsed = parseNetwork(text);
    return parsed.ok ? { ok: true, range: networkRange(parsed.network) } : parsed;
  }
  const start = parseAddress(text.slice(0, dash));
  if (!start.ok) {
    return start;
  }
  const end = parseAddress(text.slice(dash + 1));
  if (!end.ok) {
    return end;
  }
  if (start.address.version !== end.address.version) {
    return { ok: false, error: 'range-version' };
  }
  if (start.address.value > end.address.value) {
    return { ok: false, error: 'range-order' };
  }
  return {
    ok: true,
    range: { version: start.address.version, start: start.address.value, end: end.address.value },
  };
}

export type ListErrorCode = 'empty' | 'too-long' | 'too-many';

export type ParsedList =
  | { readonly ok: true; readonly ranges: readonly Range[] }
  | { readonly ok: false; readonly error: ListErrorCode }
  | {
      readonly ok: false;
      readonly error: EntryErrorCode;
      /** Line number (from 1) of the first entry that is wrong. */
      readonly line: number;
    };

/** Entries are separated by line breaks, commas or semicolons; empty entries and `#` comments are skipped. */
export function parseList(text: string): ParsedList {
  if (text.length > MAX_LIST_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  const ranges: Range[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    const content = line.split('#', 1)[0] ?? '';
    for (const piece of content.split(/[,;]/)) {
      const entry = piece.trim();
      if (entry === '') {
        continue;
      }
      if (ranges.length >= MAX_ENTRIES) {
        return { ok: false, error: 'too-many' };
      }
      const parsed = parseEntry(entry);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, line: index + 1 };
      }
      ranges.push(parsed.range);
    }
  }
  if (ranges.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, ranges };
}

/** What the summary of one IP version holds. */
export interface Summary {
  readonly version: IpVersion;
  /** Entries of this version that were read. */
  readonly entries: number;
  /** The fewest networks that cover exactly the addresses of the entries. */
  readonly networks: readonly Network[];
  /** The smallest single network that holds everything. */
  readonly supernet: Network;
  /** Addresses covered by `networks`. */
  readonly addresses: bigint;
}

/** Merges overlapping and adjacent ranges of one version, then writes the result as networks. */
export function summarise(ranges: readonly Range[]): Summary[] {
  const summaries: Summary[] = [];
  for (const version of [4, 6] as const) {
    const own = ranges.filter((range) => range.version === version);
    if (own.length === 0) {
      continue;
    }
    const sorted = [...own].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const merged: Range[] = [];
    for (const range of sorted) {
      const previous = merged.at(-1);
      if (previous !== undefined && range.start <= previous.end + 1n) {
        if (range.end > previous.end) {
          merged[merged.length - 1] = { version, start: previous.start, end: range.end };
        }
      } else {
        merged.push(range);
      }
    }
    const bits = BITS[version];
    const low = merged[0]?.start ?? 0n;
    const high = merged.at(-1)?.end ?? 0n;
    const prefix = bits - bitLength(low ^ high);
    summaries.push({
      version,
      entries: own.length,
      networks: merged.flatMap((range) => rangeToNetworks(range)),
      supernet: { version, address: low & maskOf(prefix, bits), prefix },
      addresses: merged.reduce((sum, range) => sum + (range.end - range.start + 1n), 0n),
    });
  }
  return summaries;
}

/* ---- contains ---- */

export type Relation = 'same' | 'inside' | 'contains' | 'apart';

export interface Comparison {
  /** How the second one lies to the first: inside it, around it, the same or apart. */
  readonly relation: Relation;
  /** One of the two was an IPv4 network and the other IPv6: both were compared as IPv4-mapped IPv6. */
  readonly converted: boolean;
}

/**
 * How `b` lies to `a`. The networks are cut to their prefix first. When one is IPv4 and the other
 * IPv6, the IPv4 one is written as an IPv4-mapped IPv6 network (`::ffff:a.b.c.d`), so that
 * `192.0.2.0/24` contains `::ffff:192.0.2.5`, and an IPv6 network outside `::ffff:0:0/96` is apart.
 */
export function compareNetworks(a: Network, b: Network): Comparison {
  const converted = a.version !== b.version;
  const left = converted && a.version === 4 ? ipv4ToMapped(a) : a;
  const right = converted && b.version === 4 ? ipv4ToMapped(b) : b;
  const first = networkRange(left);
  const second = networkRange(right);
  let relation: Relation;
  if (first.start === second.start && first.end === second.end) {
    relation = 'same';
  } else if (first.start <= second.start && second.end <= first.end) {
    relation = 'inside';
  } else if (second.start <= first.start && first.end <= second.end) {
    relation = 'contains';
  } else {
    relation = 'apart';
  }
  return { relation, converted };
}
