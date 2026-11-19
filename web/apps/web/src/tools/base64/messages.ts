import { i18n, t, type MessageKey } from '../../i18n/index.ts';
import { describeChar } from '../json-formatter/json.ts';
import { shown } from '../json-formatter/messages.ts';
import type { DecodeError, DecodeErrorCode } from './codec.ts';

const ERROR_KEYS: Readonly<Record<DecodeErrorCode, MessageKey>> = {
  empty: 'base64.error.empty',
  invalidChar: 'base64.error.invalidChar',
  badLength: 'base64.error.badLength',
  badPadding: 'base64.error.badPadding',
  mixedAlphabet: 'base64.error.mixedAlphabet',
  notBase64DataUri: 'base64.error.notBase64DataUri',
};

/** What is wrong with a Base64 text and where, as a visitor reads it. */
export function decodeErrorText(error: DecodeError): string {
  const message = t(ERROR_KEYS[error.code], {
    found: shown(describeChar(error.found ?? '')),
  });
  return error.code === 'empty'
    ? message
    : t('base64.error.at', { message, line: error.line, column: error.column });
}

/** A byte count for people: `1.5 MB`. */
export function formatSize(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const format = new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: unit === 0 ? 0 : 1 });
  return `${format.format(value)} ${units[unit] ?? 'B'}`;
}
