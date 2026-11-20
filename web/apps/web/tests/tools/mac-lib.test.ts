import { describe, expect, it } from 'vitest';
import {
  MAC_STYLES,
  MAX_ADDRESSES,
  MAX_INPUT_LENGTH,
  MAX_MAC_LENGTH,
  describeMac,
  formatMac,
  linkLocalAddress,
  parseMac,
  parseMacList,
  type Mac,
  type MacErrorCode,
} from '../../src/tools/mac/mac.ts';

function mac(text: string): Mac {
  const parsed = parseMac(text);
  if (!parsed.ok) {
    throw new Error(`${text}: ${parsed.error}`);
  }
  return parsed.mac;
}

function error(text: string): MacErrorCode | undefined {
  const parsed = parseMac(text);
  return parsed.ok ? undefined : parsed.error;
}

const SAME = [0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e];

describe('parseMac', () => {
  it.each([
    '00:1a:2b:3c:4d:5e',
    '00:1A:2B:3C:4D:5E',
    '00-1A-2B-3C-4D-5E',
    '001a.2b3c.4d5e',
    '001A.2B3C.4D5E',
    '001a2b3c4d5e',
    '001A2B3C4D5E',
    '001a-2b3c-4d5e',
    '001a:2b3c:4d5e',
    '0:1a:2b:3c:4d:5e',
    '  00:1a:2b:3c:4d:5e  ',
  ])('reads %s', (text) => {
    expect(mac(text).bytes).toEqual(SAME);
  });

  it('reads the forms that print single digits', () => {
    expect(mac('0:1:2:a:b:c').bytes).toEqual([0, 1, 2, 10, 11, 12]);
    expect(mac('0-1-2-a-b-c').bytes).toEqual([0, 1, 2, 10, 11, 12]);
  });

  it('reads an EUI-64 in every spelling', () => {
    const bytes = [0x00, 0x1a, 0x2b, 0xff, 0xfe, 0x3c, 0x4d, 0x5e];
    expect(mac('00:1a:2b:ff:fe:3c:4d:5e').bytes).toEqual(bytes);
    expect(mac('00-1a-2b-ff-fe-3c-4d-5e').bytes).toEqual(bytes);
    expect(mac('001a.2bff.fe3c.4d5e').bytes).toEqual(bytes);
    expect(mac('001a2bfffe3c4d5e').bytes).toEqual(bytes);
  });

  it('says what is wrong', () => {
    expect(error('')).toBe('empty');
    expect(error('   ')).toBe('empty');
    expect(error('0'.repeat(MAX_MAC_LENGTH + 1))).toBe('too-long');
    expect(error('00:1a:2b:3c:4d:5g')).toBe('characters');
    expect(error('001a2b3c4d5g')).toBe('characters');
    expect(error('00 1a 2b 3c 4d 5e')).toBe('characters');
    expect(error('00:1a-2b:3c-4d:5e')).toBe('separators');
    expect(error('001a.2b3c:4d5e')).toBe('separators');
    expect(error('00:1a:2b:3c:4d')).toBe('length');
    expect(error('00:1a:2b:3c:4d:5e:6f')).toBe('length');
    expect(error('001a2b3c4d5')).toBe('length');
    expect(error('001a2b3c4d5e6')).toBe('length');
    expect(error('001a2b3c4d5e6f')).toBe('length');
    expect(error('001a.2b3c')).toBe('length');
    expect(error('001a:2b3c:4d5e:6f70:8192:a3b4')).toBe('length');
    expect(error('00::2b:3c:4d:5e')).toBe('group');
    expect(error(':00:1a:2b:3c:4d')).toBe('group');
    expect(error('00:1a:2b:3c:4d:5e:')).toBe('group');
    expect(error('001:1a:2b:3c:4d:5e')).toBe('group');
    expect(error('001a.2b3c.4d5')).toBe('group');
    expect(error('001a.2b3c.4d5e1')).toBe('group');
    expect(error('001a-2b3c-4d')).toBe('group');
    expect(error(':')).toBe('group');
  });

  it('refuses text of the limit length that is not an address', () => {
    expect(error('0'.repeat(MAX_MAC_LENGTH))).toBe('length');
  });
});

describe('formatMac', () => {
  it('writes every style', () => {
    const value = mac('0:1a:2b:3c:4d:5e');
    expect(formatMac(value, 'colon-lower')).toBe('00:1a:2b:3c:4d:5e');
    expect(formatMac(value, 'colon-upper')).toBe('00:1A:2B:3C:4D:5E');
    expect(formatMac(value, 'dash-upper')).toBe('00-1A-2B-3C-4D-5E');
    expect(formatMac(value, 'dot-lower')).toBe('001a.2b3c.4d5e');
    expect(formatMac(value, 'bare-lower')).toBe('001a2b3c4d5e');
    expect(formatMac(value, 'bare-upper')).toBe('001A2B3C4D5E');
  });

  it('writes an EUI-64 in every style', () => {
    const value = mac('001a2bfffe3c4d5e');
    expect(formatMac(value, 'colon-lower')).toBe('00:1a:2b:ff:fe:3c:4d:5e');
    expect(formatMac(value, 'dash-upper')).toBe('00-1A-2B-FF-FE-3C-4D-5E');
    expect(formatMac(value, 'dot-lower')).toBe('001a.2bff.fe3c.4d5e');
  });

  it('reads back what it writes, in every style', () => {
    for (const text of [
      '00:00:00:00:00:00',
      'ff:ff:ff:ff:ff:ff',
      '01:23:45:67:89:ab',
      '0123456789abcdef',
    ]) {
      for (const style of MAC_STYLES) {
        expect(mac(formatMac(mac(text), style))).toEqual(mac(text));
      }
    }
  });
});

describe('describeMac', () => {
  it('reads the group bit', () => {
    expect(describeMac(mac('00:1a:2b:3c:4d:5e')).multicast).toBe(false);
    expect(describeMac(mac('01:1a:2b:3c:4d:5e')).multicast).toBe(true);
    expect(describeMac(mac('03:1a:2b:3c:4d:5e')).multicast).toBe(true);
    expect(describeMac(mac('fe:1a:2b:3c:4d:5e')).multicast).toBe(false);
    expect(describeMac(mac('ff:1a:2b:3c:4d:5e')).multicast).toBe(true);
  });

  it('reads the local bit', () => {
    expect(describeMac(mac('00:1a:2b:3c:4d:5e')).local).toBe(false);
    expect(describeMac(mac('02:1a:2b:3c:4d:5e')).local).toBe(true);
    expect(describeMac(mac('01:1a:2b:3c:4d:5e')).local).toBe(false);
    expect(describeMac(mac('06:1a:2b:3c:4d:5e')).local).toBe(true);
    expect(describeMac(mac('da:1a:2b:3c:4d:5e')).local).toBe(true);
    expect(describeMac(mac('d8:1a:2b:3c:4d:5e')).local).toBe(false);
    expect(describeMac(mac('ff:ff:ff:ff:ff:ff')).local).toBe(true);
  });

  it('names the kind and the OUI prefix', () => {
    expect(describeMac(mac('00:1a:2b:3c:4d:5e'))).toMatchObject({
      kind: 'EUI-48',
      oui: '00-1A-2B',
    });
    expect(describeMac(mac('a0b1c2d3e4f5a6b7'))).toMatchObject({ kind: 'EUI-64', oui: 'A0-B1-C2' });
  });

  it('knows the broadcast address and the two multicast ranges that have a name', () => {
    expect(describeMac(mac('ff:ff:ff:ff:ff:ff')).note).toBe('broadcast');
    expect(describeMac(mac('ff:ff:ff:ff:ff:fe')).note).toBeUndefined();
    expect(describeMac(mac('ff:ff:ff:ff:ff:ff:ff:ff')).note).toBeUndefined();
    expect(describeMac(mac('01:00:5e:00:00:fb')).note).toBe('ipv4-multicast');
    expect(describeMac(mac('01:00:5e:7f:ff:ff')).note).toBe('ipv4-multicast');
    expect(describeMac(mac('01:00:5e:80:00:00')).note).toBeUndefined();
    expect(describeMac(mac('01:00:5f:00:00:fb')).note).toBeUndefined();
    expect(describeMac(mac('01:01:5e:00:00:fb')).note).toBeUndefined();
    expect(describeMac(mac('02:00:5e:00:00:fb')).note).toBeUndefined();
    expect(describeMac(mac('33:33:00:00:00:01')).note).toBe('ipv6-multicast');
    expect(describeMac(mac('33:34:00:00:00:01')).note).toBeUndefined();
    expect(describeMac(mac('32:33:00:00:00:01')).note).toBeUndefined();
    expect(describeMac(mac('00:1a:2b:3c:4d:5e')).note).toBeUndefined();
  });
});

describe('linkLocalAddress', () => {
  it('builds the modified EUI-64 of RFC 4291, appendix A', () => {
    expect(linkLocalAddress(mac('34:56:78:9a:bc:de'))).toBe('fe80::3656:78ff:fe9a:bcde');
    expect(linkLocalAddress(mac('00:1a:2b:3c:4d:5e'))).toBe('fe80::21a:2bff:fe3c:4d5e');
  });

  it('flips the local bit both ways', () => {
    expect(linkLocalAddress(mac('02:00:00:00:00:00'))).toBe('fe80::ff:fe00:0');
    expect(linkLocalAddress(mac('00:00:00:00:00:00'))).toBe('fe80::200:ff:fe00:0');
  });

  it('takes an EUI-64 as it is, with the bit flipped', () => {
    expect(linkLocalAddress(mac('34:56:78:ff:fe:9a:bc:de'))).toBe('fe80::3656:78ff:fe9a:bcde');
  });
});

describe('parseMacList', () => {
  it('reads one address per line and keeps the line numbers', () => {
    const result = parseMacList('00:1a:2b:3c:4d:5e\r\n\n  zz  \n001a.2b3c.4d5f\r');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lines.map((line) => line.line)).toEqual([1, 3, 4]);
    expect(result.lines.map((line) => ('mac' in line ? 'mac' : line.error))).toEqual([
      'mac',
      'characters',
      'mac',
    ]);
    expect(result.lines[1]?.text).toBe('zz');
  });

  it('returns no lines for empty text', () => {
    expect(parseMacList('')).toEqual({ ok: true, lines: [] });
    expect(parseMacList('\n \n')).toEqual({ ok: true, lines: [] });
  });

  it('refuses a long input and too many addresses, at the limit', () => {
    const lines = (count: number): string =>
      Array.from({ length: count }, () => '001a2b3c4d5e').join('\n');
    expect(parseMacList(lines(MAX_ADDRESSES))).toMatchObject({ ok: true });
    expect(parseMacList(lines(MAX_ADDRESSES + 1))).toEqual({ ok: false, error: 'too-many' });
    expect(parseMacList(' '.repeat(MAX_INPUT_LENGTH))).toEqual({ ok: true, lines: [] });
    expect(parseMacList(' '.repeat(MAX_INPUT_LENGTH + 1))).toEqual({
      ok: false,
      error: 'too-long',
    });
  });
});
