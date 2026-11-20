import { describe, expect, it } from 'vitest';
import { formatAddress, ones, parseAddress, type IpVersion } from '../../src/tools/subnet/ip.ts';
import {
  MAX_ENTRIES,
  MAX_LIST_LENGTH,
  MAX_SUBNETS,
  compareNetworks,
  describeNetwork,
  formatCidr,
  ipv4ToMapped,
  mappedToIpv4,
  maskOf,
  networkRange,
  parseEntry,
  parseList,
  parseNetwork,
  powerOfTwo,
  rangeToNetworks,
  splitNetwork,
  summarise,
  type Network,
  type NetworkInfo,
  type Range,
} from '../../src/tools/subnet/net.ts';

function net(text: string): Network {
  const parsed = parseNetwork(text);
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error}`);
  }
  return parsed.network;
}

function info(text: string): NetworkInfo {
  return describeNetwork(net(text));
}

function show(version: IpVersion, value: bigint | undefined): string {
  return value === undefined ? '-' : formatAddress({ version, value });
}

function cidrs(list: readonly Network[]): string[] {
  return list.map((network) => formatCidr(network.version, network.address, network.prefix));
}

function range(start: string, end: string): Range {
  const a = parseAddress(start);
  const b = parseAddress(end);
  if (!a.ok || !b.ok) {
    throw new Error('bad range');
  }
  return { version: a.address.version, start: a.address.value, end: b.address.value };
}

describe('parseNetwork', () => {
  it('reads an address with a prefix, with a mask, and without anything', () => {
    expect(net('192.0.2.0/24')).toEqual({ version: 4, address: 0xc000_0200n, prefix: 24 });
    expect(net('192.0.2.0/255.255.255.0').prefix).toBe(24);
    expect(net(' 192.0.2.5 / 24 ').prefix).toBe(24);
    expect(net('192.0.2.5')).toEqual({ version: 4, address: 0xc000_0205n, prefix: 32 });
    expect(net('2001:db8::/32').prefix).toBe(32);
    expect(net('2001:db8::1')).toMatchObject({ version: 6, prefix: 128 });
    expect(parseNetwork('192.0.2.5')).toMatchObject({ ok: true, hadPrefix: false });
    expect(parseNetwork('192.0.2.5/32')).toMatchObject({ ok: true, hadPrefix: true });
  });

  it('accepts the edges of the prefix range', () => {
    expect(net('0.0.0.0/0').prefix).toBe(0);
    expect(net('192.0.2.1/32').prefix).toBe(32);
    expect(net('::/0').prefix).toBe(0);
    expect(net('::1/128').prefix).toBe(128);
  });

  it('reads masks of every length', () => {
    for (let prefix = 0; prefix <= 32; prefix += 1) {
      const mask = maskOf(prefix, 32);
      const text = [24n, 16n, 8n, 0n].map((shift) => String((mask >> shift) & 0xffn)).join('.');
      expect(net(`10.0.0.0/${text}`).prefix, text).toBe(prefix);
    }
  });

  it('says what is wrong', () => {
    const error = (text: string): string | undefined => {
      const parsed = parseNetwork(text);
      return parsed.ok ? undefined : parsed.error;
    };
    expect(error('')).toBe('empty');
    expect(error('/24')).toBe('empty');
    expect(error('192.0.2.0/24/8')).toBe('slash');
    expect(error('192.0.2.0/33')).toBe('prefix');
    expect(error('192.0.2.0/-1')).toBe('prefix');
    expect(error('192.0.2.0/')).toBe('prefix');
    expect(error('192.0.2.0/024')).toBe('prefix');
    expect(error('192.0.2.0/x')).toBe('prefix');
    expect(error('192.0.2.0/1000')).toBe('prefix');
    expect(error('2001:db8::/129')).toBe('prefix');
    expect(error('2001:db8::/255.255.255.0')).toBe('prefix');
    expect(error('192.0.2.0/255.0.255.0')).toBe('mask');
    expect(error('192.0.2.0/0.0.0.255')).toBe('mask');
    expect(error('192.0.2.0/1.2.3')).toBe('mask');
    expect(error('192.0.2.0/::')).toBe('prefix');
    expect(error('192.0.2.0/2001:db8::')).toBe('prefix');
    expect(error('192.0.2.256/24')).toBe('ipv4-range');
    expect(error('2001:db8::g/64')).toBe('characters');
  });
});

describe('describeNetwork, IPv4', () => {
  it('describes a /24', () => {
    const result = info('192.0.2.77/24');
    expect(show(4, result.network)).toBe('192.0.2.0');
    expect(show(4, result.broadcast)).toBe('192.0.2.255');
    expect(show(4, result.firstUsable)).toBe('192.0.2.1');
    expect(show(4, result.lastUsable)).toBe('192.0.2.254');
    expect(show(4, result.netmask)).toBe('255.255.255.0');
    expect(show(4, result.wildcard)).toBe('0.0.0.255');
    expect(result.total).toBe(256n);
    expect(result.usable).toBe(254n);
    expect(result.hostBitsSet).toBe(true);
    expect(show(4, result.given)).toBe('192.0.2.77');
  });

  it('knows when the address is the network address', () => {
    expect(info('192.0.2.0/24').hostBitsSet).toBe(false);
  });

  it('describes /0: the whole space, without the two special addresses', () => {
    const result = info('0.0.0.0/0');
    expect(show(4, result.network)).toBe('0.0.0.0');
    expect(show(4, result.broadcast)).toBe('255.255.255.255');
    expect(show(4, result.firstUsable)).toBe('0.0.0.1');
    expect(show(4, result.lastUsable)).toBe('255.255.255.254');
    expect(show(4, result.netmask)).toBe('0.0.0.0');
    expect(show(4, result.wildcard)).toBe('255.255.255.255');
    expect(result.total).toBe(4_294_967_296n);
    expect(result.usable).toBe(4_294_967_294n);
  });

  it('describes /30: two hosts', () => {
    const result = info('192.0.2.4/30');
    expect(show(4, result.firstUsable)).toBe('192.0.2.5');
    expect(show(4, result.lastUsable)).toBe('192.0.2.6');
    expect(show(4, result.broadcast)).toBe('192.0.2.7');
    expect(result.total).toBe(4n);
    expect(result.usable).toBe(2n);
  });

  it('describes /31 as a point-to-point link (RFC 3021): both addresses, no broadcast', () => {
    const result = info('192.0.2.2/31');
    expect(show(4, result.network)).toBe('192.0.2.2');
    expect(show(4, result.last)).toBe('192.0.2.3');
    expect(result.broadcast).toBeUndefined();
    expect(show(4, result.firstUsable)).toBe('192.0.2.2');
    expect(show(4, result.lastUsable)).toBe('192.0.2.3');
    expect(show(4, result.netmask)).toBe('255.255.255.254');
    expect(show(4, result.wildcard)).toBe('0.0.0.1');
    expect(result.total).toBe(2n);
    expect(result.usable).toBe(2n);
  });

  it('describes /32 as one host', () => {
    const result = info('192.0.2.9/32');
    expect(show(4, result.network)).toBe('192.0.2.9');
    expect(show(4, result.last)).toBe('192.0.2.9');
    expect(result.broadcast).toBeUndefined();
    expect(show(4, result.firstUsable)).toBe('192.0.2.9');
    expect(show(4, result.lastUsable)).toBe('192.0.2.9');
    expect(show(4, result.netmask)).toBe('255.255.255.255');
    expect(show(4, result.wildcard)).toBe('0.0.0.0');
    expect(result.total).toBe(1n);
    expect(result.usable).toBe(1n);
  });

  it('keeps netmask and wildcard complementary for every prefix', () => {
    for (let prefix = 0; prefix <= 32; prefix += 1) {
      const result = describeNetwork({ version: 4, address: 0xc000_0245n, prefix });
      expect(result.netmask ^ result.wildcard).toBe(ones(32));
      expect(result.total).toBe(1n << BigInt(32 - prefix));
      expect(result.last - result.network + 1n).toBe(result.total);
      expect(result.network & result.wildcard).toBe(0n);
      expect(result.usable).toBe(prefix >= 31 ? result.total : result.total - 2n);
    }
  });
});

describe('describeNetwork, IPv6', () => {
  it('describes a /64: every address is usable, there is no broadcast address', () => {
    const result = info('2001:db8:1:2:3:4:5:6/64');
    expect(show(6, result.network)).toBe('2001:db8:1:2::');
    expect(show(6, result.last)).toBe('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(result.broadcast).toBeUndefined();
    expect(show(6, result.firstUsable)).toBe('2001:db8:1:2::');
    expect(show(6, result.lastUsable)).toBe('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(show(6, result.netmask)).toBe('ffff:ffff:ffff:ffff::');
    expect(show(6, result.wildcard)).toBe('::ffff:ffff:ffff:ffff');
    expect(result.total).toBe(1n << 64n);
    expect(result.usable).toBe(1n << 64n);
    expect(result.hostBitsSet).toBe(true);
  });

  it('describes /0', () => {
    const result = info('::/0');
    expect(show(6, result.network)).toBe('::');
    expect(show(6, result.last)).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(show(6, result.netmask)).toBe('::');
    expect(result.total).toBe(1n << 128n);
    expect(result.usable).toBe(1n << 128n);
  });

  it('describes /127 as two addresses (RFC 6164)', () => {
    const result = info('2001:db8::2/127');
    expect(show(6, result.network)).toBe('2001:db8::2');
    expect(show(6, result.last)).toBe('2001:db8::3');
    expect(show(6, result.firstUsable)).toBe('2001:db8::2');
    expect(show(6, result.lastUsable)).toBe('2001:db8::3');
    expect(result.total).toBe(2n);
    expect(result.usable).toBe(2n);
    expect(show(6, result.netmask)).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe');
  });

  it('describes /128 as one address', () => {
    const result = info('2001:db8::1/128');
    expect(show(6, result.network)).toBe('2001:db8::1');
    expect(show(6, result.last)).toBe('2001:db8::1');
    expect(result.total).toBe(1n);
    expect(result.usable).toBe(1n);
    expect(show(6, result.wildcard)).toBe('::');
    expect(show(6, result.netmask)).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(result.hostBitsSet).toBe(false);
  });

  it('describes a /48 and a /56', () => {
    expect(info('2001:db8:abcd::/48').total).toBe(1n << 80n);
    expect(show(6, info('2001:db8:abcd:ff00::/56').last)).toBe(
      '2001:db8:abcd:ffff:ffff:ffff:ffff:ffff',
    );
  });

  it('keeps netmask and wildcard complementary for every prefix', () => {
    for (let prefix = 0; prefix <= 128; prefix += 1) {
      const result = describeNetwork({ version: 6, address: 0x2001_0db8n << 96n, prefix });
      expect(result.netmask ^ result.wildcard).toBe(ones(128));
      expect(result.total).toBe(1n << BigInt(128 - prefix));
      expect(result.usable).toBe(result.total);
    }
  });
});

describe('formatting helpers', () => {
  it('writes a CIDR with the host bits cleared', () => {
    expect(formatCidr(4, 0xc000_024dn, 24)).toBe('192.0.2.0/24');
    expect(formatCidr(6, 0x2001_0db8_0000_0000_0000_0000_0000_0001n, 32)).toBe('2001:db8::/32');
    expect(formatCidr(4, 0xffff_ffffn, 0)).toBe('0.0.0.0/0');
  });

  it('names a power of two, and nothing else', () => {
    expect(powerOfTwo(0n)).toBeUndefined();
    expect(powerOfTwo(1n)).toBeUndefined();
    expect(powerOfTwo(2n)).toBe('2^1');
    expect(powerOfTwo(256n)).toBe('2^8');
    expect(powerOfTwo(255n)).toBeUndefined();
    expect(powerOfTwo(1n << 128n)).toBe('2^128');
    expect(powerOfTwo((1n << 64n) + 1n)).toBeUndefined();
  });
});

describe('IPv4-mapped networks', () => {
  it('turns a mapped IPv6 network into IPv4 and back', () => {
    const mapped = net('::ffff:192.0.2.0/120');
    expect(mappedToIpv4(mapped)).toEqual({ version: 4, address: 0xc000_0200n, prefix: 24 });
    const back = ipv4ToMapped(net('192.0.2.0/24'));
    expect(back).toEqual(mapped);
    expect(formatCidr(6, back.address, back.prefix)).toBe('::ffff:192.0.2.0/120');
  });

  it('handles the edges: the whole mapped block, a single address, a wider network, other addresses', () => {
    expect(mappedToIpv4(net('::ffff:0.0.0.0/96'))).toEqual({ version: 4, address: 0n, prefix: 0 });
    expect(mappedToIpv4(net('::ffff:192.0.2.1/128'))?.prefix).toBe(32);
    expect(mappedToIpv4(net('::ffff:0.0.0.0/95'))).toBeUndefined();
    expect(mappedToIpv4(net('2001:db8::/120'))).toBeUndefined();
    expect(mappedToIpv4(net('192.0.2.0/24'))).toBeUndefined();
    expect(ipv4ToMapped(net('0.0.0.0/0')).prefix).toBe(96);
    expect(ipv4ToMapped(net('192.0.2.1/32')).prefix).toBe(128);
  });
});

describe('splitNetwork', () => {
  const byCount = (network: string, text: string): ReturnType<typeof splitNetwork> =>
    splitNetwork(net(network), { by: 'count', text });
  const byPrefix = (network: string, text: string): ReturnType<typeof splitNetwork> =>
    splitNetwork(net(network), { by: 'prefix', text });
  const error = (result: ReturnType<typeof splitNetwork>): string | undefined =>
    result.ok ? undefined : result.error;

  it('splits by the number of subnets', () => {
    const result = byCount('192.0.2.0/24', '4');
    expect(result).toMatchObject({ ok: true, prefix: 26, count: 4 });
    expect(result.ok && cidrs(result.subnets)).toEqual([
      '192.0.2.0/26',
      '192.0.2.64/26',
      '192.0.2.128/26',
      '192.0.2.192/26',
    ]);
  });

  it('splits by the new prefix length', () => {
    const result = byPrefix('198.51.100.0/24', '26');
    expect(result.ok && cidrs(result.subnets)).toEqual([
      '198.51.100.0/26',
      '198.51.100.64/26',
      '198.51.100.128/26',
      '198.51.100.192/26',
    ]);
  });

  it('cuts the host bits of the input first', () => {
    const result = byCount('192.0.2.77/24', '2');
    expect(result.ok && cidrs(result.subnets)).toEqual(['192.0.2.0/25', '192.0.2.128/25']);
  });

  it('splits into one: the network itself', () => {
    expect(byCount('192.0.2.0/24', '1')).toMatchObject({ ok: true, prefix: 24, count: 1 });
    expect(byPrefix('192.0.2.0/24', '24')).toMatchObject({ ok: true, prefix: 24, count: 1 });
  });

  it('splits /0 and the smallest networks', () => {
    const half = byCount('0.0.0.0/0', '2');
    expect(half.ok && cidrs(half.subnets)).toEqual(['0.0.0.0/1', '128.0.0.0/1']);
    const pair = byPrefix('192.0.2.0/30', '31');
    expect(pair.ok && cidrs(pair.subnets)).toEqual(['192.0.2.0/31', '192.0.2.2/31']);
    const hosts = byPrefix('192.0.2.2/31', '32');
    expect(hosts.ok && cidrs(hosts.subnets)).toEqual(['192.0.2.2/32', '192.0.2.3/32']);
    expect(byPrefix('192.0.2.5/32', '32')).toMatchObject({ ok: true, count: 1 });
    const v6 = byPrefix('2001:db8::/126', '127');
    expect(v6.ok && cidrs(v6.subnets)).toEqual(['2001:db8::/127', '2001:db8::2/127']);
    const last = byCount('2001:db8::2/127', '2');
    expect(last.ok && cidrs(last.subnets)).toEqual(['2001:db8::2/128', '2001:db8::3/128']);
  });

  it('splits IPv6 into /64s', () => {
    const result = byPrefix('2001:db8::/62', '64');
    expect(result.ok && cidrs(result.subnets)).toEqual([
      '2001:db8::/64',
      '2001:db8:0:1::/64',
      '2001:db8:0:2::/64',
      '2001:db8:0:3::/64',
    ]);
  });

  it('lists exactly the maximum and refuses one more', () => {
    const most = byPrefix('10.0.0.0/8', '20');
    expect(most.ok && most.count).toBe(MAX_SUBNETS);
    expect(most.ok && most.subnets).toHaveLength(MAX_SUBNETS);
    expect(most.ok && cidrs(most.subnets).at(-1)).toBe('10.255.240.0/20');
    expect(error(byPrefix('10.0.0.0/8', '21'))).toBe('too-many');
    expect(error(byCount('10.0.0.0/8', '8192'))).toBe('too-many');
    expect(byCount('10.0.0.0/8', '4096')).toMatchObject({ ok: true, count: 4096 });
    expect(error(byPrefix('2001:db8::/32', '64'))).toBe('too-many');
    expect(error(byCount('::/0', '1267650600228229401496703205376'))).toBe('too-many');
  });

  it('refuses what cannot be done', () => {
    expect(error(byCount('192.0.2.0/24', ''))).toBe('empty');
    expect(error(byCount('192.0.2.0/24', '  '))).toBe('empty');
    expect(error(byCount('192.0.2.0/24', '0'))).toBe('number');
    expect(error(byCount('192.0.2.0/24', '-2'))).toBe('number');
    expect(error(byCount('192.0.2.0/24', '2.5'))).toBe('number');
    expect(error(byCount('192.0.2.0/24', 'two'))).toBe('number');
    expect(error(byCount('192.0.2.0/24', '1'.repeat(41)))).toBe('number');
    expect(error(byCount('192.0.2.0/24', '3'))).toBe('power');
    expect(error(byCount('192.0.2.0/24', '6'))).toBe('power');
    expect(error(byCount('192.0.2.0/24', '512'))).toBe('too-small');
    expect(error(byCount('192.0.2.0/24', '256'))).toBeUndefined();
    expect(error(byCount('192.0.2.0/32', '2'))).toBe('too-small');
    expect(error(byCount('2001:db8::/127', '4'))).toBe('too-small');
    expect(error(byPrefix('192.0.2.0/24', '23'))).toBe('range');
    expect(error(byPrefix('192.0.2.0/24', '33'))).toBe('range');
    expect(error(byPrefix('2001:db8::/32', '129'))).toBe('range');
    expect(error(byPrefix('192.0.2.0/24', '/26'))).toBe('number');
    expect(error(byPrefix('192.0.2.0/24', '-1'))).toBe('number');
    expect(error(byPrefix('192.0.2.0/24', '026'))).toBe('number');
    expect(error(byPrefix('192.0.2.0/24', '10000'))).toBe('number');
  });

  it('covers the network exactly, without gaps or overlap', () => {
    for (const [text, prefix] of [
      ['192.0.2.0/24', 29],
      ['10.0.0.0/16', 20],
      ['2001:db8::/48', 52],
    ] as const) {
      const network = net(text);
      const result = splitNetwork(network, { by: 'prefix', text: String(prefix) });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const whole = describeNetwork(network);
      let expectedStart = whole.network;
      for (const subnet of result.subnets) {
        const part = describeNetwork(subnet);
        expect(part.network).toBe(expectedStart);
        expectedStart = part.last + 1n;
      }
      expect(expectedStart - 1n).toBe(whole.last);
    }
  });
});

describe('rangeToNetworks', () => {
  const list = (start: string, end: string): string[] => cidrs(rangeToNetworks(range(start, end)));

  it('writes aligned blocks as one network', () => {
    expect(list('192.0.2.0', '192.0.2.255')).toEqual(['192.0.2.0/24']);
    expect(list('192.0.2.7', '192.0.2.7')).toEqual(['192.0.2.7/32']);
    expect(list('0.0.0.0', '255.255.255.255')).toEqual(['0.0.0.0/0']);
    expect(list('::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toEqual(['::/0']);
    expect(list('2001:db8::', '2001:db8::ffff:ffff:ffff:ffff')).toEqual(['2001:db8::/64']);
  });

  it('writes a range that is not aligned as the fewest networks', () => {
    expect(list('192.0.2.1', '192.0.2.6')).toEqual([
      '192.0.2.1/32',
      '192.0.2.2/31',
      '192.0.2.4/31',
      '192.0.2.6/32',
    ]);
    expect(list('192.0.2.0', '192.0.2.200')).toEqual([
      '192.0.2.0/25',
      '192.0.2.128/26',
      '192.0.2.192/29',
      '192.0.2.200/32',
    ]);
    expect(list('0.0.0.1', '255.255.255.255')).toHaveLength(32);
    expect(list('::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toHaveLength(128);
    expect(list('255.255.255.254', '255.255.255.255')).toEqual(['255.255.255.254/31']);
  });

  it('covers exactly the range, for random ranges', () => {
    let state = 12345;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12345) >>> 0;
      return state;
    };
    for (let index = 0; index < 300; index += 1) {
      const a = BigInt(next());
      const b = BigInt(next());
      const [start, end] = a <= b ? [a, b] : [b, a];
      const networks = rangeToNetworks({ version: 4, start, end });
      let expectedStart = start;
      for (const network of networks) {
        const part = describeNetwork(network);
        expect(part.hostBitsSet).toBe(false);
        expect(part.network).toBe(expectedStart);
        expectedStart = part.last + 1n;
      }
      expect(expectedStart - 1n).toBe(end);
      // No two neighbours could be one bigger network.
      for (let at = 0; at + 1 < networks.length; at += 1) {
        const left = networks[at];
        const right = networks[at + 1];
        if (left !== undefined && left.prefix === right?.prefix) {
          expect(describeNetwork(left).network % (1n << BigInt(33 - left.prefix))).not.toBe(0n);
        }
      }
    }
  });

  it('gives the range of a network', () => {
    expect(networkRange(net('192.0.2.77/24'))).toEqual(range('192.0.2.0', '192.0.2.255'));
  });
});

describe('parseEntry', () => {
  it('reads a network, an address and a range', () => {
    expect(parseEntry('192.0.2.0/24')).toEqual({
      ok: true,
      range: range('192.0.2.0', '192.0.2.255'),
    });
    expect(parseEntry('192.0.2.5')).toEqual({ ok: true, range: range('192.0.2.5', '192.0.2.5') });
    expect(parseEntry('192.0.2.5-192.0.2.9')).toEqual({
      ok: true,
      range: range('192.0.2.5', '192.0.2.9'),
    });
    expect(parseEntry('192.0.2.5 - 192.0.2.5')).toEqual({
      ok: true,
      range: range('192.0.2.5', '192.0.2.5'),
    });
    expect(parseEntry('2001:db8::1-2001:db8::9')).toMatchObject({ ok: true });
  });

  it('says what is wrong', () => {
    const error = (text: string): string | undefined => {
      const result = parseEntry(text);
      return result.ok ? undefined : result.error;
    };
    expect(error('192.0.2.9-192.0.2.5')).toBe('range-order');
    expect(error('192.0.2.1-2001:db8::1')).toBe('range-version');
    expect(error('192.0.2.1-')).toBe('empty');
    expect(error('-192.0.2.1')).toBe('empty');
    expect(error('192.0.2.1-x')).toBe('ipv4-octets');
    expect(error('x-192.0.2.1')).toBe('ipv4-octets');
    expect(error('192.0.2.0/99')).toBe('prefix');
    expect(error('nonsense')).toBe('ipv4-octets');
  });
});

describe('parseList', () => {
  it('reads entries separated by line breaks, commas and semicolons, and skips comments and empty ones', () => {
    const result = parseList(
      '192.0.2.0/25\r\n\n192.0.2.128/25, 198.51.100.1 ; 203.0.113.0/24 # a comment\n# only a comment\n',
    );
    expect(result.ok && result.ranges).toHaveLength(4);
  });

  it('names the line of the first entry that is wrong', () => {
    expect(parseList('192.0.2.0/24\n\n192.0.2.300')).toEqual({
      ok: false,
      error: 'ipv4-range',
      line: 3,
    });
    expect(parseList('# c\nx')).toEqual({ ok: false, error: 'ipv4-octets', line: 2 });
  });

  it('refuses an empty list, a long list and too many entries, at the limit', () => {
    expect(parseList('')).toEqual({ ok: false, error: 'empty' });
    expect(parseList(' \n# nothing\n')).toEqual({ ok: false, error: 'empty' });
    expect(parseList(' '.repeat(MAX_LIST_LENGTH + 1))).toEqual({ ok: false, error: 'too-long' });
    expect(parseList(`192.0.2.1${' '.repeat(MAX_LIST_LENGTH - 9)}`)).toMatchObject({ ok: true });
    const entry = (count: number): string =>
      Array.from({ length: count }, () => '192.0.2.1').join('\n');
    expect(parseList(entry(MAX_ENTRIES))).toMatchObject({ ok: true });
    expect(parseList(entry(MAX_ENTRIES + 1))).toEqual({ ok: false, error: 'too-many' });
  });
});

describe('summarise', () => {
  const run = (text: string): ReturnType<typeof summarise> => {
    const parsed = parseList(text);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return summarise(parsed.ranges);
  };

  it('joins neighbours into one network', () => {
    const [summary] = run('192.0.2.0/25\n192.0.2.128/25');
    expect(summary && cidrs(summary.networks)).toEqual(['192.0.2.0/24']);
    expect(summary?.addresses).toBe(256n);
    expect(summary?.entries).toBe(2);
    expect(summary && cidrs([summary.supernet])).toEqual(['192.0.2.0/24']);
  });

  it('drops networks that lie inside another and merges overlaps, whatever the order', () => {
    const [summary] = run(
      '192.0.2.64/26\n192.0.2.0/24\n192.0.2.10-192.0.2.20\n198.51.100.0/25\n198.51.100.100-198.51.100.200',
    );
    expect(summary && cidrs(summary.networks)).toEqual([
      '192.0.2.0/24',
      '198.51.100.0/25',
      '198.51.100.128/26',
      '198.51.100.192/29',
      '198.51.100.200/32',
    ]);
    expect(summary?.addresses).toBe(256n + 201n);
  });

  it('does not join two networks with a gap', () => {
    const [summary] = run('192.0.2.0/25\n192.0.2.129');
    expect(summary && cidrs(summary.networks)).toEqual(['192.0.2.0/25', '192.0.2.129/32']);
    expect(summary && cidrs([summary.supernet])).toEqual(['192.0.2.0/24']);
  });

  it('finds the smallest network that holds everything', () => {
    const [summary] = run('10.1.0.0/16\n10.2.0.0/16');
    expect(summary && cidrs([summary.supernet])).toEqual(['10.0.0.0/14']);
    const [single] = run('192.0.2.5');
    expect(single && cidrs([single.supernet])).toEqual(['192.0.2.5/32']);
    const [wide] = run('0.0.0.0\n255.255.255.255');
    expect(wide && cidrs([wide.supernet])).toEqual(['0.0.0.0/0']);
    const [v6] = run('2001:db8:1::/48\n2001:db8:2::/48');
    expect(v6 && cidrs([v6.supernet])).toEqual(['2001:db8::/46']);
  });

  it('keeps IPv4 and IPv6 apart, IPv4 first', () => {
    const summaries = run('2001:db8::/33\n2001:db8:8000::/33\n192.0.2.0/24');
    expect(summaries.map((summary) => summary.version)).toEqual([4, 6]);
    expect(summaries[1] && cidrs(summaries[1].networks)).toEqual(['2001:db8::/32']);
    expect(run('192.0.2.1')).toHaveLength(1);
    expect(run('2001:db8::1')).toHaveLength(1);
  });

  it('handles the whole space and the last address', () => {
    const [all] = run('0.0.0.0/1\n128.0.0.0/1');
    expect(all && cidrs(all.networks)).toEqual(['0.0.0.0/0']);
    expect(all?.addresses).toBe(4_294_967_296n);
    const [end] = run('255.255.255.255\n255.255.255.254');
    expect(end && cidrs(end.networks)).toEqual(['255.255.255.254/31']);
    const [duplicate] = run('192.0.2.1\n192.0.2.1\n192.0.2.1');
    expect(duplicate && cidrs(duplicate.networks)).toEqual(['192.0.2.1/32']);
    expect(duplicate?.entries).toBe(3);
  });

  it('is exact: every address of the input is in the output and nothing else', () => {
    let state = 99;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12345) >>> 0;
      return state;
    };
    for (let round = 0; round < 40; round += 1) {
      const ranges: Range[] = Array.from({ length: 6 }, () => {
        const start = BigInt(next() % 2000);
        return { version: 4 as const, start, end: start + BigInt(next() % 150) };
      });
      const covered = new Set<bigint>();
      for (const { start, end } of ranges) {
        for (let address = start; address <= end; address += 1n) {
          covered.add(address);
        }
      }
      const [summary] = summarise(ranges);
      const out = new Set<bigint>();
      for (const network of summary?.networks ?? []) {
        const part = describeNetwork(network);
        for (let address = part.network; address <= part.last; address += 1n) {
          expect(out.has(address)).toBe(false);
          out.add(address);
        }
      }
      expect(out).toEqual(covered);
      expect(summary?.addresses).toBe(BigInt(covered.size));
    }
  });
});

describe('compareNetworks', () => {
  const relation = (a: string, b: string): string => compareNetworks(net(a), net(b)).relation;

  it('finds an address inside a network, and one outside', () => {
    expect(relation('192.0.2.0/24', '192.0.2.5')).toBe('inside');
    expect(relation('192.0.2.0/24', '192.0.2.0')).toBe('inside');
    expect(relation('192.0.2.0/24', '192.0.2.255')).toBe('inside');
    expect(relation('192.0.2.0/24', '192.0.3.0')).toBe('apart');
    expect(relation('192.0.2.0/24', '192.0.1.255')).toBe('apart');
    expect(relation('2001:db8::/32', '2001:db8:ffff::1')).toBe('inside');
    expect(relation('2001:db8::/32', '2001:db9::1')).toBe('apart');
  });

  it('compares two networks: the same, inside, around and apart', () => {
    expect(relation('192.0.2.0/24', '192.0.2.0/24')).toBe('same');
    expect(relation('192.0.2.0/24', '192.0.2.99/24')).toBe('same');
    expect(relation('192.0.2.0/24', '192.0.2.128/25')).toBe('inside');
    expect(relation('192.0.2.128/25', '192.0.2.0/24')).toBe('contains');
    expect(relation('192.0.2.0/25', '192.0.2.128/25')).toBe('apart');
    expect(relation('0.0.0.0/0', '203.0.113.7')).toBe('inside');
    expect(relation('192.0.2.7/32', '192.0.2.7')).toBe('same');
    expect(relation('192.0.2.7/32', '192.0.2.8')).toBe('apart');
    expect(relation('192.0.2.2/31', '192.0.2.3')).toBe('inside');
    expect(relation('2001:db8::/127', '2001:db8::2')).toBe('apart');
    expect(relation('2001:db8::/127', '2001:db8::1')).toBe('inside');
    expect(relation('::/0', '2001:db8::/32')).toBe('inside');
    expect(relation('2001:db8::1/128', '2001:db8::1')).toBe('same');
  });

  it('says whether an IPv4 and an IPv6 side were compared through the mapped form', () => {
    expect(compareNetworks(net('192.0.2.0/24'), net('192.0.2.5'))).toMatchObject({
      converted: false,
    });
    expect(compareNetworks(net('192.0.2.0/24'), net('::ffff:192.0.2.5'))).toEqual({
      relation: 'inside',
      converted: true,
    });
    expect(compareNetworks(net('::ffff:192.0.2.0/120'), net('192.0.2.5'))).toEqual({
      relation: 'inside',
      converted: true,
    });
    expect(relation('::ffff:192.0.2.0/120', '192.0.3.5')).toBe('apart');
    expect(relation('192.0.2.0/24', '::ffff:192.0.2.0/120')).toBe('same');
    expect(relation('::ffff:0.0.0.0/96', '192.0.2.0/24')).toBe('inside');
    expect(relation('0.0.0.0/0', '::ffff:192.0.2.0/120')).toBe('inside');
    expect(relation('192.0.2.0/24', '::ffff:192.0.0.0/112')).toBe('contains');
  });

  it('keeps native IPv6 apart from IPv4', () => {
    expect(relation('192.0.2.0/24', '2001:db8::1')).toBe('apart');
    expect(relation('2001:db8::/32', '192.0.2.1')).toBe('apart');
    expect(relation('0.0.0.0/0', '::1')).toBe('apart');
    expect(relation('::/0', '192.0.2.1')).toBe('inside');
  });
});
