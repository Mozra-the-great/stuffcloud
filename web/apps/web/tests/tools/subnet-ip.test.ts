import { isIPv4, isIPv6 } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  bitLength,
  expandV6,
  formatAddress,
  formatV4,
  formatV6,
  fromMapped,
  isMapped,
  MAX_ADDRESS_LENGTH,
  ones,
  parseAddress,
  toMapped,
  type AddressErrorCode,
  type Address,
} from '../../src/tools/subnet/ip.ts';

function value(text: string): bigint {
  const parsed = parseAddress(text);
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error}`);
  }
  return parsed.address.value;
}

function error(text: string): AddressErrorCode | undefined {
  const parsed = parseAddress(text);
  return parsed.ok ? undefined : parsed.error;
}

/** A small deterministic generator (xorshift32), so a failing case can be repeated. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function randomBits(next: () => number, bits: number): bigint {
  let result = 0n;
  for (let done = 0; done < bits; done += 32) {
    result = (result << 32n) | BigInt(next());
  }
  return result & ones(bits);
}

describe('bit helpers', () => {
  it('builds masks of ones', () => {
    expect(ones(0)).toBe(0n);
    expect(ones(1)).toBe(1n);
    expect(ones(32)).toBe(0xffff_ffffn);
    expect(ones(128)).toBe((1n << 128n) - 1n);
  });

  it('measures the length of a number in bits', () => {
    expect(bitLength(0n)).toBe(0);
    expect(bitLength(1n)).toBe(1);
    expect(bitLength(255n)).toBe(8);
    expect(bitLength(256n)).toBe(9);
    expect(bitLength(1n << 127n)).toBe(128);
  });
});

describe('IPv4 addresses', () => {
  it('reads the corners of the range', () => {
    expect(value('0.0.0.0')).toBe(0n);
    expect(value('255.255.255.255')).toBe(0xffff_ffffn);
    expect(value('192.0.2.1')).toBe(0xc000_0201n);
    expect(value('  198.51.100.7  ')).toBe(0xc633_6407n);
  });

  it('says what is wrong, by the first rule that fails', () => {
    expect(error('')).toBe('empty');
    expect(error('   ')).toBe('empty');
    expect(error('1.2.3')).toBe('ipv4-octets');
    expect(error('1.2.3.4.5')).toBe('ipv4-octets');
    expect(error('1.2..4')).toBe('ipv4-octets');
    expect(error('1.2.3.')).toBe('ipv4-octets');
    expect(error('1.2.3.x')).toBe('characters');
    expect(error('1.2.3.-4')).toBe('characters');
    expect(error('1.2.3.4 5')).toBe('characters');
    expect(error('256.0.0.1')).toBe('ipv4-range');
    expect(error('1.2.3.999')).toBe('ipv4-range');
    expect(error('1.2.3.04')).toBe('ipv4-zero');
    expect(error('01.2.3.4')).toBe('ipv4-zero');
    expect(error('1.2.3.0')).toBeUndefined();
    expect(error('example')).toBe('ipv4-octets');
  });

  it('refuses text that is too long, at the limit', () => {
    expect(error('1'.repeat(MAX_ADDRESS_LENGTH))).toBe('ipv4-octets');
    expect(error('1'.repeat(MAX_ADDRESS_LENGTH + 1))).toBe('too-long');
  });

  it('writes dotted decimals', () => {
    expect(formatV4(0n)).toBe('0.0.0.0');
    expect(formatV4(0xffff_ffffn)).toBe('255.255.255.255');
    expect(formatV4(0x0102_0304n)).toBe('1.2.3.4');
  });

  it('agrees with node:net on which texts are IPv4 addresses', () => {
    for (const text of [
      '1.2.3.4',
      '0.0.0.0',
      '255.255.255.255',
      '1.2.3',
      '1.2.3.256',
      'a.b.c.d',
      '1.2.3.4.5',
    ]) {
      const ours = parseAddress(text);
      expect(ours.ok && ours.address.version === 4, text).toBe(isIPv4(text));
    }
  });

  it('round-trips random addresses', () => {
    const next = random(1);
    for (let index = 0; index < 500; index += 1) {
      const original = randomBits(next, 32);
      expect(value(formatV4(original))).toBe(original);
    }
  });
});

describe('IPv6 addresses', () => {
  it('reads full, shortened and embedded forms', () => {
    expect(value('::')).toBe(0n);
    expect(value('::1')).toBe(1n);
    expect(value('2001:db8::1')).toBe((0x2001_0db8n << 96n) | 1n);
    expect(value('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(value('2001:db8::1'));
    expect(value('2001:DB8::1')).toBe(value('2001:db8::1'));
    expect(value('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(ones(128));
    expect(value('1::')).toBe(1n << 112n);
    expect(value('1:2:3:4:5:6:7::')).toBe(value('1:2:3:4:5:6:7:0'));
    expect(value('::2:3:4:5:6:7:8')).toBe(value('0:2:3:4:5:6:7:8'));
    expect(value('::ffff:192.0.2.1')).toBe(0xffff_c000_0201n);
    expect(value('64:ff9b::192.0.2.33')).toBe(value('64:ff9b::c000:221'));
    expect(value('1:2:3:4:5:6:192.0.2.1')).toBe(value('1:2:3:4:5:6:c000:201'));
  });

  it('says what is wrong, by the first rule that fails', () => {
    expect(error('fe80::1%eth0')).toBe('ipv6-zone');
    expect(error('2001:db8::g')).toBe('characters');
    expect(error('2001:db8:::1')).toBe('ipv6-colons');
    expect(error('2001::db8::1')).toBe('ipv6-colons');
    expect(error(':1:2:3:4:5:6:7')).toBe('ipv6-colons');
    expect(error('1:2:3:4:5:6:7:')).toBe('ipv6-colons');
    expect(error('1:2:3:4:5:6:7')).toBe('ipv6-groups');
    expect(error('1:2:3:4:5:6:7:8:9')).toBe('ipv6-groups');
    expect(error('1:2:3:4:5:6:7:8::')).toBe('ipv6-groups');
    expect(error('::1:2:3:4:5:6:7:8')).toBe('ipv6-groups');
    expect(error('12345::1')).toBe('ipv6-group');
    expect(error('::ffff:192.0.2')).toBe('ipv6-ipv4');
    expect(error('::ffff:192.0.2.256')).toBe('ipv6-ipv4');
    expect(error('1.2.3.4::1')).toBe('ipv6-ipv4');
    expect(error('::1.2.3.4:5')).toBe('ipv6-ipv4');
    expect(error('::1:')).toBe('ipv6-colons');
    expect(error('1:2:3:4:5:6:7:8')).toBeUndefined();
    expect(error(':')).toBe('ipv6-colons');
  });

  it('refuses text that is too long', () => {
    expect(error(`::${'1'.repeat(MAX_ADDRESS_LENGTH)}`)).toBe('too-long');
  });

  it('compresses like RFC 5952', () => {
    expect(formatV6(0n)).toBe('::');
    expect(formatV6(1n)).toBe('::1');
    expect(formatV6(value('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe('2001:db8::1');
    // The longest run wins, the first one on a tie, and one zero group is not shortened.
    expect(formatV6(value('2001:db8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1');
    expect(formatV6(value('2001:db8:0:1:1:1:1:1'))).toBe('2001:db8:0:1:1:1:1:1');
    expect(formatV6(value('1:0:0:2:0:0:0:3'))).toBe('1:0:0:2::3');
    expect(formatV6(value('0:0:0:1:0:0:0:0'))).toBe('0:0:0:1::');
    expect(formatV6(value('1::'))).toBe('1::');
    expect(formatV6(value('ABCD:EF01::'))).toBe('abcd:ef01::');
  });

  it('keeps the dotted tail of an IPv4-mapped address', () => {
    expect(formatV6(value('::ffff:c000:201'))).toBe('::ffff:192.0.2.1');
    expect(formatV6(value('::ffff:0:0'))).toBe('::ffff:0.0.0.0');
    // Next to it, but not mapped.
    expect(formatV6(value('::fffe:c000:201'))).toBe('::fffe:c000:201');
    expect(formatV6(value('1::ffff:c000:201'))).toBe('1::ffff:c000:201');
  });

  it('writes all eight groups with four digits', () => {
    expect(expandV6(0n)).toBe('0000:0000:0000:0000:0000:0000:0000:0000');
    expect(expandV6(value('2001:db8::1'))).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(expandV6(ones(128))).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
  });

  it('agrees with node:net on which texts are IPv6 addresses', () => {
    for (const text of [
      '::',
      '::1',
      '1::',
      '1:2:3:4:5:6:7:8',
      '1:2:3:4:5:6:7::',
      '::ffff:1.2.3.4',
      ':::',
      '1::2::3',
      '12345::',
      'g::',
      '1:2:3:4:5:6:7:8:9',
    ]) {
      const ours = parseAddress(text);
      expect(ours.ok && ours.address.version === 6, text).toBe(isIPv6(text));
    }
  });

  it('agrees with the URL serialiser (a second implementation) on random addresses', () => {
    const next = random(7);
    for (let index = 0; index < 400; index += 1) {
      let original = randomBits(next, 128);
      // Make zero groups likely, to exercise the compression.
      for (let group = 0; group < 8; group += 1) {
        if (next() % 3 === 0) {
          original &= ~(0xffffn << BigInt(16 * group));
        }
      }
      if (isMapped({ version: 6, value: original })) {
        continue;
      }
      const host = new URL(`http://[${expandV6(original)}]/`).hostname;
      expect(formatV6(original)).toBe(host.slice(1, -1));
      expect(value(formatV6(original))).toBe(original);
      expect(value(expandV6(original))).toBe(original);
    }
  });

  it('round-trips random IPv4-mapped addresses', () => {
    const next = random(11);
    for (let index = 0; index < 200; index += 1) {
      const original = (0xffffn << 32n) | randomBits(next, 32);
      expect(value(formatV6(original))).toBe(original);
    }
  });
});

describe('IPv4-mapped addresses', () => {
  const v4: Address = { version: 4, value: 0xc000_0201n };

  it('maps an IPv4 address into ::ffff:0:0/96 and back', () => {
    const mapped = toMapped(v4);
    expect(mapped).toEqual({ version: 6, value: 0xffff_c000_0201n });
    expect(isMapped(mapped)).toBe(true);
    expect(fromMapped(mapped)).toEqual(v4);
    expect(formatAddress(mapped)).toBe('::ffff:192.0.2.1');
  });

  it('knows an address that is not mapped', () => {
    expect(isMapped(v4)).toBe(false);
    expect(isMapped({ version: 6, value: 1n })).toBe(false);
    expect(isMapped({ version: 6, value: 0xfffe_0000_0000n })).toBe(false);
    expect(isMapped({ version: 6, value: (1n << 100n) | (0xffffn << 32n) })).toBe(false);
    expect(fromMapped({ version: 6, value: 1n })).toBeUndefined();
    expect(fromMapped(v4)).toBeUndefined();
  });

  it('formats by version', () => {
    expect(formatAddress(v4)).toBe('192.0.2.1');
    expect(formatAddress({ version: 6, value: value('2001:db8::1') })).toBe('2001:db8::1');
  });
});
