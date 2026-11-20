import { describe, expect, it } from 'vitest';
import { parseMac, type Mac } from '../../src/tools/mac/mac.ts';
import { OuiIndex, MAX_NAME_LENGTH, parseCsv, parseOui } from '../../src/tools/mac/oui.ts';
import { HEADER, SAMPLE_MA_L, csv } from './mac-fixtures.ts';

function mac(text: string): Mac {
  const parsed = parseMac(text);
  if (!parsed.ok) {
    throw new Error(text);
  }
  return parsed.mac;
}

function rows(text: string): readonly (readonly string[])[] | undefined {
  const parsed = parseCsv(text);
  return parsed.ok ? parsed.rows : undefined;
}

describe('parseCsv', () => {
  it('reads plain rows, with every kind of line ending and with or without a last one', () => {
    expect(rows('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(rows('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(rows('a,b\rc,d\r')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(rows('')).toEqual([]);
    expect(rows('\n\n')).toEqual([]);
    expect(rows('a')).toEqual([['a']]);
  });

  it('reads quoted fields: commas, doubled quotes and line breaks inside', () => {
    expect(rows('"a,b","say ""hi""","line\nbreak"\n')).toEqual([
      ['a,b', 'say "hi"', 'line\nbreak'],
    ]);
    expect(rows('"a\r\nb",c')).toEqual([['a\r\nb', 'c']]);
  });

  it('keeps empty fields and rows of one empty field', () => {
    expect(rows('a,,c\n')).toEqual([['a', '', 'c']]);
    expect(rows(',\n')).toEqual([['', '']]);
    expect(rows('""\n')).toEqual([['']]);
    expect(rows('a,\n')).toEqual([['a', '']]);
  });

  it('takes a quote inside an unquoted field as it is', () => {
    expect(rows('ab"c,d\n')).toEqual([['ab"c', 'd']]);
  });

  it('drops a byte order mark', () => {
    expect(rows('﻿a,b\n')).toEqual([['a', 'b']]);
  });

  it('refuses a quote that is never closed', () => {
    expect(parseCsv('a,"b\nc')).toEqual({ ok: false, error: 'unterminated' });
    expect(parseCsv('"')).toEqual({ ok: false, error: 'unterminated' });
    expect(parseCsv('"a""')).toEqual({ ok: false, error: 'unterminated' });
  });
});

describe('parseOui', () => {
  it('reads the IEEE layout', () => {
    const parsed = parseOui(SAMPLE_MA_L);
    expect(parsed).toEqual({
      ok: true,
      prefixes: ['00A0B0', '04D5E6', '08F1A2'],
      names: ['Example Networks Ltd', 'Sample "Quoted" Devices, Inc.', 'Test Systems GmbH'],
      skipped: 0,
    });
  });

  it('finds the columns by name, in any order and case, with a byte order mark', () => {
    const parsed = parseOui('﻿Organization Name,registry,ASSIGNMENT\nExample Corp,MA-L,00a0b0\n');
    expect(parsed).toEqual({ ok: true, prefixes: ['00A0B0'], names: ['Example Corp'], skipped: 0 });
    expect(parseOui('Organisation Name,Assignment\nExample Corp,00A0B1\n')).toMatchObject({
      ok: true,
    });
  });

  it('reads all three lengths and counts the rows that are no entry', () => {
    const parsed = parseOui(
      csv([
        ['MA-L', '00A0B0', 'One'],
        ['MA-M', '1C2D3E4', 'Two'],
        ['MA-S', '8C1F64ABC', 'Three'],
        ['MA-L', '00A0B', 'Short'],
        ['MA-L', '00A0B0C1', 'Eight digits'],
        ['MA-L', '00A0BG', 'Not hex'],
        ['MA-L', '00A0B2', ''],
        ['MA-L', '00A0B3'],
        ['MA-L'],
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      prefixes: ['00A0B0', '1C2D3E4', '8C1F64ABC'],
      names: ['One', 'Two', 'Three'],
      skipped: 6,
    });
  });

  it('tidies the name: white space is one space, and it is cut at the limit', () => {
    const long = 'x'.repeat(MAX_NAME_LENGTH + 50);
    const parsed = parseOui(
      csv([
        ['MA-L', '00A0B0', '  Example \n  Corp  '],
        ['MA-L', '00A0B1', long],
      ]),
    );
    expect(parsed).toMatchObject({
      ok: true,
      names: ['Example Corp', 'x'.repeat(MAX_NAME_LENGTH)],
    });
  });

  it('says what is wrong with a file', () => {
    expect(parseOui('')).toEqual({ ok: false, error: 'columns' });
    expect(parseOui('a,b,c\n1,2,3\n')).toEqual({ ok: false, error: 'columns' });
    expect(parseOui('Assignment\n00A0B0\n')).toEqual({ ok: false, error: 'columns' });
    expect(parseOui('Organization Name\nExample\n')).toEqual({ ok: false, error: 'columns' });
    expect(parseOui(`${HEADER}\n`)).toEqual({ ok: false, error: 'empty' });
    expect(parseOui(`${HEADER}\nMA-L,zz,Name,Address\n`)).toEqual({ ok: false, error: 'empty' });
    expect(parseOui(`${HEADER}\n"MA-L,00A0B0`)).toEqual({ ok: false, error: 'unterminated' });
  });
});

describe('OuiIndex', () => {
  const index = new OuiIndex(
    ['00A0B0', '04D5E6', '1C2D3E4', '8C1F64ABC', '8C1F64'],
    [
      'Example Networks Ltd',
      'Test Devices Inc',
      'Medium Block Co',
      'Small Block Co',
      'Big Block Co',
    ],
  );

  it('counts its entries', () => {
    expect(index.size).toBe(5);
    expect(new OuiIndex([], []).size).toBe(0);
  });

  it('looks up a vendor by the first three bytes', () => {
    expect(index.lookup(mac('00:a0:b0:11:22:33'))).toEqual({
      name: 'Example Networks Ltd',
      prefix: '00A0B0',
      registry: 'MA-L',
    });
    expect(index.lookup(mac('04-D5-E6-FF-FF-FF'))?.name).toBe('Test Devices Inc');
    expect(index.lookup(mac('00a0b011223344ff'))?.name).toBe('Example Networks Ltd');
  });

  it('prefers the longest assignment: MA-S before MA-M before MA-L', () => {
    expect(index.lookup(mac('8c:1f:64:ab:c1:23'))).toMatchObject({
      name: 'Small Block Co',
      registry: 'MA-S',
      prefix: '8C1F64ABC',
    });
    expect(index.lookup(mac('8c:1f:64:ab:d1:23'))).toMatchObject({
      name: 'Big Block Co',
      registry: 'MA-L',
    });
    expect(index.lookup(mac('1c:2d:3e:4f:00:00'))).toMatchObject({
      name: 'Medium Block Co',
      registry: 'MA-M',
      prefix: '1C2D3E4',
    });
    expect(index.lookup(mac('1c:2d:3e:5f:00:00'))).toBeUndefined();
  });

  it('ignores the group bit, because the registry lists the OUI without it', () => {
    expect(index.lookup(mac('01:a0:b0:00:00:00'))?.name).toBe('Example Networks Ltd');
    expect(index.lookup(mac('05:d5:e6:00:00:00'))?.name).toBe('Test Devices Inc');
    expect(index.lookup(mac('01:00:00:00:00:00'))).toBeUndefined();
  });

  it('finds no vendor for a locally administered address', () => {
    const local = new OuiIndex(['02A0B0', '06A0B0'], ['Never', 'Never']);
    expect(local.lookup(mac('02:a0:b0:11:22:33'))).toBeUndefined();
    expect(local.lookup(mac('06:a0:b0:11:22:33'))).toBeUndefined();
  });

  it('finds nothing for an unknown prefix', () => {
    expect(index.lookup(mac('00:a0:b1:00:00:00'))).toBeUndefined();
  });

  it('lets a later entry win when a prefix is listed twice', () => {
    const twice = new OuiIndex(['00A0B0', '00A0B0'], ['First', 'Second']);
    expect(twice.size).toBe(1);
    expect(twice.lookup(mac('00:a0:b0:00:00:00'))?.name).toBe('Second');
  });
});
