import type { Locale } from './locales.ts';
import type { Message, MessageParams } from './types.ts';

/** `{name}`: a placeholder. Anything else with a brace is a syntax error (see check.ts). */
export const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The text of `message` for `params.count` in `locale` (plain text is returned unchanged). */
export function pickForm(locale: Locale, message: Message, params?: MessageParams): string {
  if (typeof message === 'string') {
    return message;
  }
  const count = params?.['count'];
  if (typeof count !== 'number') {
    return message.other;
  }
  return message[new Intl.PluralRules(locale).select(count)] ?? message.other;
}

/**
 * Fills in `{name}` placeholders. Numbers are formatted for the locale (`1.000` in German);
 * a placeholder without a value stays visible, so a missing parameter is noticed.
 */
export function formatMessage(locale: Locale, message: Message, params?: MessageParams): string {
  const template = pickForm(locale, message, params);
  if (params === undefined) {
    return template;
  }
  return template.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      return placeholder;
    }
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
  });
}
