import { describe, expect, it } from 'vitest';
import { formatV6, isMapped, parseAddress } from '../../src/tools/subnet/ip.ts';
import {
  compareNetworks,
  mappedToIpv4,
  parseList,
  parseNetwork,
  splitNetwork,
  summarise,
  type Network,
  type Range,
} from '../../src/tools/subnet/net.ts';

function net(text: string): Network {
  const parsed = parseNetwork(text);
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error}`);
  }
  return parsed.network;
}

function range(text: string): Range {
  const network = net(text);
  const size = 1n << BigInt((network.version === 4 ? 32 : 128) - network.prefix);
  const start = network.address & ~(size - 1n);
  return { version: network.version, start, end: start + size - 1n };
}

describe('IPv6 text with an IPv4 tail', () => {
  it('refuses a dot anywhere before the last colon, whatever sits next to the colon', () => {
    for (const text of [
      '1.:1.2.3.4',
      '.:1.2.3.4',
      '1.2.3.4::1.2.3.4',
      '::1.2.3.4:1.2.3.4',
      'a.b:1.2.3.4',
    ]) {
      expect(parseAddress(text), text).toEqual({ ok: false, error: 'ipv6-ipv4' });
    }
  });

  it('reads the tail as the last two groups', () => {
    const parsed = parseAddress('::ffff:192.0.2.1');
    expect(parsed).toEqual({ ok: true, address: { version: 6, value: 0xffffc0000201n } });
  });
});

describe('IPv6 colons', () => {
  it.each([
    ':::',
    '1:::2',
    '::::',
    '1::2::3',
    ':1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:',
    '1::2:',
    ':1::2',
  ])('refuses %s with the colon error', (text) => {
    expect(parseAddress(text)).toEqual({ ok: false, error: 'ipv6-colons' });
  });

  it('fills the gap with as many zero groups as are missing', () => {
    const value = (text: string): bigint | undefined => {
      const parsed = parseAddress(text);
      return parsed.ok ? parsed.address.value : undefined;
    };
    expect(value('::')).toBe(0n);
    expect(value('1::')).toBe(1n << 112n);
    expect(value('::1')).toBe(1n);
    expect(value('1::2')).toBe((1n << 112n) | 2n);
    expect(value('1:2:3:4:5:6:7::')).toBe(0x0001_0002_0003_0004_0005_0006_0007_0000n);
    expect(value('::2:3:4:5:6:7:8')).toBe(0x0000_0002_0003_0004_0005_0006_0007_0008n);
    expect(value('1:2:3:4:5:6:7:8')).toBe(0x0001_0002_0003_0004_0005_0006_0007_0008n);
  });

  it('wants exactly eight groups without a gap, and at most seven with one', () => {
    expect(parseAddress('1:2:3:4:5:6:7')).toEqual({ ok: false, error: 'ipv6-groups' });
    expect(parseAddress('1:2:3:4:5:6:7:8:9')).toEqual({ ok: false, error: 'ipv6-groups' });
    expect(parseAddress('1:2:3:4::5:6:7:8')).toEqual({ ok: false, error: 'ipv6-groups' });
    expect(parseAddress('1:2:3:4::5:6:7').ok).toBe(true);
  });
});

describe('IPv4-mapped detection', () => {
  it('only an IPv6 address in ::ffff:0:0/96 is mapped', () => {
    expect(isMapped({ version: 6, value: 0xffff_0000_0000n })).toBe(true);
    expect(isMapped({ version: 6, value: 0xffff_ffff_ffffn })).toBe(true);
    expect(isMapped({ version: 6, value: 0xfffe_ffff_ffffn })).toBe(false);
    expect(isMapped({ version: 6, value: 0x1_ffff_0000_0000n })).toBe(false);
    expect(isMapped({ version: 6, value: 0xffff_ffffn })).toBe(false);
    expect(isMapped({ version: 4, value: 0xffff_ffffn })).toBe(false);
    expect(isMapped({ version: 4, value: 0n })).toBe(false);
  });
});

describe('IPv6 text form (RFC 5952)', () => {
  const text = (address: string): string => {
    const parsed = parseAddress(address);
    if (!parsed.ok || parsed.address.version !== 6) {
      throw new Error(address);
    }
    return formatV6(parsed.address.value);
  };

  it('writes the longest run of zero groups as ::', () => {
    expect(text('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
    expect(text('2001:db8:0:0:0:1:0:1')).toBe('2001:db8::1:0:1');
    expect(text('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
    expect(text('0:0:0:0:0:0:0:0')).toBe('::');
    expect(text('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(text('1:0:0:0:0:0:0:0')).toBe('1::');
    expect(text('0:0:1:0:0:0:0:0')).toBe('0:0:1::');
  });

  it('puts the first of two equally long runs into the ::', () => {
    expect(text('1:0:0:2:0:0:3:4')).toBe('1::2:0:0:3:4');
    expect(text('0:0:1:0:0:2:3:4')).toBe('::1:0:0:2:3:4');
    expect(text('1:2:0:0:3:0:0:4')).toBe('1:2::3:0:0:4');
    expect(text('1:0:0:2:3:4:0:0')).toBe('1::2:3:4:0:0');
  });

  it('never writes a single zero group as ::', () => {
    expect(text('1:0:2:0:3:0:4:5')).toBe('1:0:2:0:3:0:4:5');
    expect(text('0:1:2:3:4:5:6:7')).toBe('0:1:2:3:4:5:6:7');
    expect(text('1:2:3:4:5:6:7:0')).toBe('1:2:3:4:5:6:7:0');
    expect(text('1:2:3:0:4:5:6:7')).toBe('1:2:3:0:4:5:6:7');
  });

  it('handles a run that ends at the last group, and one that starts at the first', () => {
    expect(text('1:2:3:4:5:0:0:0')).toBe('1:2:3:4:5::');
    expect(text('0:0:0:4:5:6:7:8')).toBe('::4:5:6:7:8');
    expect(text('1:2:3:4:5:6:0:0')).toBe('1:2:3:4:5:6::');
    expect(text('0:0:3:4:5:6:7:8')).toBe('::3:4:5:6:7:8');
  });

  it('a longer later run wins over an earlier shorter one', () => {
    expect(text('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
    expect(text('0:0:1:0:0:0:2:3')).toBe('0:0:1::2:3');
    expect(text('1:0:0:0:2:0:0:0')).toBe('1::2:0:0:0');
  });
});

describe('parseNetwork with a mask', () => {
  it('says that a prefix was given, also when it was written as a mask', () => {
    expect(parseNetwork('192.0.2.0/255.255.255.0')).toMatchObject({
      ok: true,
      hadPrefix: true,
      network: { version: 4, prefix: 24 },
    });
    expect(parseNetwork('192.0.2.0/24')).toMatchObject({ ok: true, hadPrefix: true });
    expect(parseNetwork('192.0.2.0')).toMatchObject({ ok: true, hadPrefix: false });
  });

  it.each([
    '192.0.2.0/255.255.0.x',
    '192.0.2.0/255.255.0',
    '192.0.2.0/255.0.255.0',
    '192.0.2.0/0.255.255.255',
    '192.0.2.0/::ffff:255.255.255.0',
    // An IPv6 address is no mask, even when its low 32 bits would be one.
    '192.0.2.0/::255.255.255.0',
    '192.0.2.0/1.2.3.4.5',
    '192.0.2.0/256.0.0.0',
    '192.0.2.0/255.255.255.255.',
  ])('refuses the mask in %s with the mask error and does not throw', (text) => {
    expect(parseNetwork(text)).toEqual({ ok: false, error: 'mask' });
  });

  it('takes white space around the whole text and around the prefix', () => {
    expect(parseNetwork('  192.0.2.0/24  ')).toMatchObject({ ok: true, network: { prefix: 24 } });
    expect(parseNetwork('\t192.0.2.7 \n')).toMatchObject({ ok: true, hadPrefix: false });
    expect(parseNetwork(' 192.0.2.0/ 24 ')).toMatchObject({ ok: true, network: { prefix: 24 } });
    expect(parseNetwork(' 2001:db8::/32 ')).toMatchObject({ ok: true, network: { prefix: 32 } });
  });
});

describe('mappedToIpv4', () => {
  it('needs a prefix of 96 or more, even for a mapped address', () => {
    const mapped = (prefix: number): Network => ({
      version: 6,
      address: 0xffff_c000_0201n,
      prefix,
    });
    expect(mappedToIpv4(mapped(96))).toEqual({ version: 4, address: 0xc000_0201n, prefix: 0 });
    expect(mappedToIpv4(mapped(97))).toEqual({ version: 4, address: 0xc000_0201n, prefix: 1 });
    expect(mappedToIpv4(mapped(128))).toEqual({ version: 4, address: 0xc000_0201n, prefix: 32 });
    expect(mappedToIpv4(mapped(95))).toBeUndefined();
    expect(mappedToIpv4(mapped(64))).toBeUndefined();
    expect(mappedToIpv4(mapped(0))).toBeUndefined();
  });

  it('is nothing for an IPv4 network', () => {
    expect(mappedToIpv4({ version: 4, address: 0xffffn, prefix: 32 })).toBeUndefined();
  });
});

describe('splitNetwork by a count', () => {
  const count = (text: string, network = '10.0.0.0/8'): unknown =>
    splitNetwork(net(network), { by: 'count', text });

  it('is exact at the number of digits it reads', () => {
    // 2^130 has 40 digits: it is read as a number and then found too big for a /0.
    const forty = (2n ** 130n).toString();
    expect(forty).toHaveLength(40);
    expect(count(forty, '::/0')).toEqual({ ok: false, error: 'too-small' });
    // One digit more is not read at all.
    const fortyOne = (2n ** 133n).toString();
    expect(fortyOne).toHaveLength(41);
    expect(count(fortyOne, '::/0')).toEqual({ ok: false, error: 'number' });
  });

  it('refuses a count that is not written as a plain positive number', () => {
    for (const text of ['0', '01', '-2', '2.0', '1e3', '0x10', ' ', 'two', '+4']) {
      expect(count(text), text).toMatchObject({ ok: false });
    }
    expect(count('1')).toMatchObject({ ok: true, count: 1 });
  });
});

describe('parseList comments', () => {
  it('cuts a line at the first #, however many follow, and keeps a line without one whole', () => {
    expect(parseList('192.0.2.0/24 # a # b\n198.51.100.0/24')).toMatchObject({
      ok: true,
      ranges: [{ version: 4 }, { version: 4 }],
    });
    expect(parseList('#192.0.2.0/24\n198.51.100.0/24')).toMatchObject({
      ok: true,
      ranges: [{ version: 4 }],
    });
    expect(parseList('192.0.2.0/24#\n')).toMatchObject({ ok: true, ranges: [{ version: 4 }] });
    expect(parseList('# nothing but a comment')).toMatchObject({ ok: false });
  });
});

describe('summarise: the order of the input does not matter', () => {
  const merged = (...networks: string[]): string[] =>
    summarise(networks.map(range)).flatMap((summary) =>
      summary.networks.map((network) => `${String(network.address)}/${String(network.prefix)}`),
    );

  it('sorts by the start of the range, not by the order of the list', () => {
    const forward = merged('10.0.0.0/24', '10.0.2.0/24', '10.0.4.0/24', '10.0.6.0/24');
    expect(forward).toHaveLength(4);
    for (const order of [
      ['10.0.6.0/24', '10.0.4.0/24', '10.0.2.0/24', '10.0.0.0/24'],
      ['10.0.4.0/24', '10.0.0.0/24', '10.0.6.0/24', '10.0.2.0/24'],
      ['10.0.2.0/24', '10.0.6.0/24', '10.0.0.0/24', '10.0.4.0/24'],
    ]) {
      expect(merged(...order)).toEqual(forward);
    }
  });

  it('joins neighbours that arrive in reverse order', () => {
    expect(merged('10.0.1.0/24', '10.0.0.0/24')).toEqual(merged('10.0.0.0/23'));
    expect(merged('10.0.3.0/24', '10.0.2.0/24', '10.0.1.0/24', '10.0.0.0/24')).toEqual(
      merged('10.0.0.0/22'),
    );
  });

  it('keeps the wide range when a narrower one that starts inside it comes later or earlier', () => {
    expect(merged('10.0.0.0/8', '10.1.0.0/16')).toEqual(merged('10.0.0.0/8'));
    expect(merged('10.1.0.0/16', '10.0.0.0/8')).toEqual(merged('10.0.0.0/8'));
    expect(merged('10.0.0.0/8', '10.255.0.0/16', '10.1.0.0/16')).toEqual(merged('10.0.0.0/8'));
    expect(merged('10.1.0.0/16', '10.255.0.0/16', '10.0.0.0/8')).toEqual(merged('10.0.0.0/8'));
  });

  it('extends a range that a later one overlaps at its end, and not when it only touches inside', () => {
    expect(merged('10.0.0.0/24', '10.0.0.128/25', '10.0.1.0/24')).toEqual(merged('10.0.0.0/23'));
    expect(merged('10.0.0.0/23', '10.0.1.0/24')).toEqual(merged('10.0.0.0/23'));
    expect(merged('10.0.1.0/24', '10.0.0.0/23')).toEqual(merged('10.0.0.0/23'));
  });

  it('puts the supernet around the lowest start and the highest end of the whole list', () => {
    const [summary] = summarise([range('10.0.8.0/24'), range('10.0.0.0/24'), range('10.0.4.0/24')]);
    expect(summary?.supernet).toEqual({ version: 4, address: 0x0a00_0000n, prefix: 20 });
    expect(summary?.entries).toBe(3);
  });

  it('counts the addresses once however the ranges overlap', () => {
    const [summary] = summarise([
      range('10.0.0.0/24'),
      range('10.0.0.0/25'),
      range('10.0.0.128/25'),
    ]);
    expect(summary?.addresses).toBe(256n);
  });
});

describe('compareNetworks: networks that start at the same address', () => {
  const relation = (a: string, b: string): string => compareNetworks(net(a), net(b)).relation;

  it('says how the second lies to the first: inside it, around it, or the same', () => {
    expect(relation('10.0.0.0/8', '10.0.0.0/16')).toBe('inside');
    expect(relation('10.0.0.0/16', '10.0.0.0/8')).toBe('contains');
    expect(relation('10.0.0.0/16', '10.0.0.0/16')).toBe('same');
    expect(relation('2001:db8::/32', '2001:db8::/48')).toBe('inside');
    expect(relation('2001:db8::/48', '2001:db8::/32')).toBe('contains');
  });

  it('networks that end at the same address', () => {
    expect(relation('10.0.0.0/8', '10.255.0.0/16')).toBe('inside');
    expect(relation('10.255.0.0/16', '10.0.0.0/8')).toBe('contains');
  });

  it('neighbours and disjoint networks are apart', () => {
    expect(relation('10.0.0.0/24', '10.0.1.0/24')).toBe('apart');
    expect(relation('10.0.1.0/24', '10.0.0.0/24')).toBe('apart');
  });
});
