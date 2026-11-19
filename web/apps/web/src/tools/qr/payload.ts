/**
 * What goes into a QR code: free text or a URL as it is, a Wi-Fi login (the `WIFI:` format that phone
 * cameras understand) or a contact card (vCard 3.0). Pure functions; the fields are what the form
 * holds, the result is the text to encode or the first thing that is missing.
 */

export type PayloadKind = 'text' | 'wifi' | 'contact';

export const PAYLOAD_KINDS: readonly PayloadKind[] = ['text', 'wifi', 'contact'];

export type WifiSecurity = 'WPA' | 'WEP' | 'nopass';

export const WIFI_SECURITIES: readonly WifiSecurity[] = ['WPA', 'WEP', 'nopass'];

export interface WifiFields {
  readonly ssid: string;
  readonly password: string;
  readonly security: WifiSecurity;
  readonly hidden: boolean;
}

export interface ContactFields {
  readonly firstName: string;
  readonly lastName: string;
  readonly organisation: string;
  readonly phone: string;
  readonly email: string;
  readonly website: string;
}

export type PayloadError =
  | { readonly code: 'empty' }
  | { readonly code: 'ssid' }
  | { readonly code: 'ssid-length'; readonly max: number }
  | { readonly code: 'password' }
  | { readonly code: 'contact' };

export type PayloadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: PayloadError };

/** A Wi-Fi network name is at most 32 bytes (IEEE 802.11). */
export const SSID_MAX_BYTES = 32;

const BACKSLASH = String.fromCharCode(92);

/** `text` with a backslash in front of each character in `special` (and of the backslash itself). */
function escapeWith(text: string, special: readonly string[]): string {
  let escaped = '';
  for (const character of text) {
    escaped +=
      character === BACKSLASH || special.includes(character) ? BACKSLASH + character : character;
  }
  return escaped;
}

/** The characters the Wi-Fi format reserves. */
const WIFI_SPECIAL: readonly string[] = [';', ',', ':', '"'];

export function escapeWifi(text: string): string {
  return escapeWith(text, WIFI_SPECIAL);
}

/** The characters vCard 3.0 reserves in a value; a line break becomes the two characters `\n`. */
export function escapeVCard(text: string): string {
  let escaped = '';
  for (const character of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')) {
    if (character === '\n') {
      escaped += `${BACKSLASH}n`;
    } else if (character === BACKSLASH || character === ';' || character === ',') {
      escaped += BACKSLASH + character;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

export function wifiPayload(fields: WifiFields): PayloadResult {
  const ssid = fields.ssid;
  if (ssid === '') {
    return { ok: false, error: { code: 'ssid' } };
  }
  if (new TextEncoder().encode(ssid).length > SSID_MAX_BYTES) {
    return { ok: false, error: { code: 'ssid-length', max: SSID_MAX_BYTES } };
  }
  if (fields.security !== 'nopass' && fields.password === '') {
    return { ok: false, error: { code: 'password' } };
  }
  let text = `WIFI:T:${fields.security};S:${escapeWifi(ssid)};`;
  if (fields.security !== 'nopass') {
    text += `P:${escapeWifi(fields.password)};`;
  }
  if (fields.hidden) {
    text += 'H:true;';
  }
  return { ok: true, text: `${text};` };
}

export function contactPayload(fields: ContactFields): PayloadResult {
  const first = fields.firstName.trim();
  const last = fields.lastName.trim();
  const organisation = fields.organisation.trim();
  if (first === '' && last === '' && organisation === '') {
    return { ok: false, error: { code: 'contact' } };
  }
  const display = [first, last].filter((part) => part !== '').join(' ');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVCard(last)};${escapeVCard(first)};;;`,
    `FN:${escapeVCard(display === '' ? organisation : display)}`,
  ];
  const optional: readonly (readonly [string, string])[] = [
    ['ORG', organisation],
    ['TEL', fields.phone.trim()],
    ['EMAIL', fields.email.trim()],
    ['URL', fields.website.trim()],
  ];
  for (const [name, value] of optional) {
    if (value !== '') {
      lines.push(`${name}:${escapeVCard(value)}`);
    }
  }
  lines.push('END:VCARD');
  return { ok: true, text: lines.join('\r\n') };
}

export function textPayload(text: string): PayloadResult {
  return text === '' ? { ok: false, error: { code: 'empty' } } : { ok: true, text };
}
