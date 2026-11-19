import { describe, expect, it } from 'vitest';
import {
  SSID_MAX_BYTES,
  contactPayload,
  escapeVCard,
  escapeWifi,
  textPayload,
  wifiPayload,
  type ContactFields,
  type WifiFields,
} from '../../src/tools/qr/payload.ts';

const B = String.fromCharCode(92);

const wifi: WifiFields = { ssid: 'Home', password: 'secret-pass', security: 'WPA', hidden: false };
const contact: ContactFields = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  organisation: '',
  phone: '',
  email: '',
  website: '',
};

describe('text', () => {
  it('is taken as it is, and an empty text is refused', () => {
    expect(textPayload('https://example.org/a?b=c')).toEqual({
      ok: true,
      text: 'https://example.org/a?b=c',
    });
    expect(textPayload(' ')).toEqual({ ok: true, text: ' ' });
    expect(textPayload('')).toEqual({ ok: false, error: { code: 'empty' } });
  });
});

describe('escapeWifi', () => {
  it('puts a backslash before the backslash, semicolon, comma, colon and quote', () => {
    expect(escapeWifi('plain')).toBe('plain');
    expect(escapeWifi(';')).toBe(`${B};`);
    expect(escapeWifi(',')).toBe(`${B},`);
    expect(escapeWifi(':')).toBe(`${B}:`);
    expect(escapeWifi('"')).toBe(`${B}"`);
    expect(escapeWifi(B)).toBe(`${B}${B}`);
    expect(escapeWifi(`a;b,c:d"e${B}f`)).toBe(`a${B};b${B},c${B}:d${B}"e${B}${B}f`);
    expect(escapeWifi('ümlaut 日本 😀')).toBe('ümlaut 日本 😀');
  });
});

describe('wifiPayload', () => {
  it('writes the WIFI: format with a closing double semicolon', () => {
    expect(wifiPayload(wifi)).toEqual({ ok: true, text: 'WIFI:T:WPA;S:Home;P:secret-pass;;' });
    expect(wifiPayload({ ...wifi, security: 'WEP' })).toEqual({
      ok: true,
      text: 'WIFI:T:WEP;S:Home;P:secret-pass;;',
    });
  });

  it('marks a hidden network and leaves the password out of an open one', () => {
    expect(wifiPayload({ ...wifi, hidden: true })).toEqual({
      ok: true,
      text: 'WIFI:T:WPA;S:Home;P:secret-pass;H:true;;',
    });
    expect(wifiPayload({ ...wifi, security: 'nopass', password: 'ignored' })).toEqual({
      ok: true,
      text: 'WIFI:T:nopass;S:Home;;',
    });
    expect(wifiPayload({ ...wifi, security: 'nopass', password: '', hidden: true })).toEqual({
      ok: true,
      text: 'WIFI:T:nopass;S:Home;H:true;;',
    });
  });

  it('escapes the name and the password', () => {
    const result = wifiPayload({ ...wifi, ssid: 'a;b', password: 'p:"q"' });
    expect(result).toEqual({
      ok: true,
      text: `WIFI:T:WPA;S:a${B};b;P:p${B}:${B}"q${B}";;`,
    });
  });

  it('refuses a missing name, a name over 32 bytes and a missing password', () => {
    expect(wifiPayload({ ...wifi, ssid: '' })).toEqual({ ok: false, error: { code: 'ssid' } });
    expect(wifiPayload({ ...wifi, password: '' })).toEqual({
      ok: false,
      error: { code: 'password' },
    });
    expect(wifiPayload({ ...wifi, security: 'WEP', password: '' })).toEqual({
      ok: false,
      error: { code: 'password' },
    });
    expect(wifiPayload({ ...wifi, ssid: 'x'.repeat(SSID_MAX_BYTES) }).ok).toBe(true);
    expect(wifiPayload({ ...wifi, ssid: 'x'.repeat(SSID_MAX_BYTES + 1) })).toEqual({
      ok: false,
      error: { code: 'ssid-length', max: 32 },
    });
    // The limit counts bytes: 11 euro signs are 33 bytes of UTF-8 but only 11 characters.
    expect(wifiPayload({ ...wifi, ssid: '€'.repeat(11) })).toEqual({
      ok: false,
      error: { code: 'ssid-length', max: 32 },
    });
    expect(wifiPayload({ ...wifi, ssid: '€'.repeat(10) }).ok).toBe(true);
  });

  it('checks the name before the password', () => {
    expect(wifiPayload({ ...wifi, ssid: '', password: '' })).toEqual({
      ok: false,
      error: { code: 'ssid' },
    });
  });
});

describe('escapeVCard', () => {
  it('escapes backslash, comma and semicolon and turns line breaks into \\n', () => {
    expect(escapeVCard('plain')).toBe('plain');
    expect(escapeVCard('a,b;c')).toBe(`a${B},b${B};c`);
    expect(escapeVCard(B)).toBe(`${B}${B}`);
    expect(escapeVCard('one\ntwo')).toBe(`one${B}ntwo`);
    expect(escapeVCard('one\r\ntwo\rthree')).toBe(`one${B}ntwo${B}nthree`);
    expect(escapeVCard('a:b')).toBe('a:b');
  });
});

describe('contactPayload', () => {
  it('writes a vCard 3.0 with CRLF line ends', () => {
    expect(contactPayload(contact)).toEqual({
      ok: true,
      text: [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'N:Lovelace;Ada;;;',
        'FN:Ada Lovelace',
        'END:VCARD',
      ].join('\r\n'),
    });
  });

  it('adds the organisation, phone, e-mail and website that are filled in, trimmed', () => {
    const result = contactPayload({
      firstName: ' Ada ',
      lastName: 'Lovelace',
      organisation: 'Analytical, Ltd',
      phone: ' +49 30 1234567 ',
      email: 'ada@example.org',
      website: 'https://example.org/ada',
    });
    expect(result).toEqual({
      ok: true,
      text: [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'N:Lovelace;Ada;;;',
        'FN:Ada Lovelace',
        `ORG:Analytical${B}, Ltd`,
        'TEL:+49 30 1234567',
        'EMAIL:ada@example.org',
        'URL:https://example.org/ada',
        'END:VCARD',
      ].join('\r\n'),
    });
  });

  it('takes the organisation as the display name when there is no personal name', () => {
    const result = contactPayload({
      ...contact,
      firstName: '',
      lastName: '',
      organisation: 'ACME',
    });
    expect(result).toEqual({
      ok: true,
      text: ['BEGIN:VCARD', 'VERSION:3.0', 'N:;;;;', 'FN:ACME', 'ORG:ACME', 'END:VCARD'].join(
        '\r\n',
      ),
    });
  });

  it('works with a first or a last name alone', () => {
    const onlyFirst = contactPayload({ ...contact, lastName: '' });
    expect(onlyFirst.ok && onlyFirst.text).toContain('N:;Ada;;;\r\nFN:Ada\r\n');
    const onlyLast = contactPayload({ ...contact, firstName: '' });
    expect(onlyLast.ok && onlyLast.text).toContain('N:Lovelace;;;;\r\nFN:Lovelace\r\n');
  });

  it('escapes names so that a semicolon cannot add a field', () => {
    const result = contactPayload({ ...contact, lastName: 'A;B', firstName: 'C,D' });
    expect(result.ok && result.text).toContain(`N:A${B};B;C${B},D;;;`);
  });

  it('refuses a card without any name or organisation', () => {
    expect(contactPayload({ ...contact, firstName: ' ', lastName: '' })).toEqual({
      ok: false,
      error: { code: 'contact' },
    });
    expect(contactPayload({ ...contact, firstName: '', lastName: '', phone: '123' })).toEqual({
      ok: false,
      error: { code: 'contact' },
    });
  });
});
