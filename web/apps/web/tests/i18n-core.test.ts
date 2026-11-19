import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  detectLocale,
  isLocale,
  matchLocale,
} from '../src/i18n/locales.ts';
import { formatMessage, pickForm } from '../src/i18n/translate.ts';

describe('locales', () => {
  it('ships German and English, English being the default', () => {
    expect(LOCALES).toEqual(['de', 'en']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(LOCALE_NAMES).toEqual({ de: 'Deutsch', en: 'English' });
  });

  it('recognises exactly the shipped locales', () => {
    expect(isLocale('de')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale('DE')).toBe(false);
  });

  it.each([
    ['de', 'de'],
    ['de-AT', 'de'],
    ['DE_ch', 'de'],
    ['  en-GB ', 'en'],
    ['en', 'en'],
  ])('maps %s to %s by the primary subtag', (tag, locale) => {
    expect(matchLocale(tag)).toBe(locale);
  });

  it.each(['fr', 'fr-DE', '', 'deu', 'd'])('does not map %j', (tag) => {
    expect(matchLocale(tag)).toBeUndefined();
  });

  it('detects the first supported language of the browser list', () => {
    expect(detectLocale(['fr-FR', 'de-DE', 'en'])).toBe('de');
    expect(detectLocale(['en-US', 'de'])).toBe('en');
  });

  it('falls back to the default when nothing matches or the list is empty', () => {
    expect(detectLocale(['fr', 'ja'])).toBe(DEFAULT_LOCALE);
    expect(detectLocale([])).toBe(DEFAULT_LOCALE);
  });
});

describe('pickForm', () => {
  const plural = { one: 'one {count}', other: 'many {count}' };

  it('returns plain text unchanged', () => {
    expect(pickForm('en', 'text', { count: 3 })).toBe('text');
  });

  it('selects the CLDR category of the count', () => {
    expect(pickForm('en', plural, { count: 1 })).toBe('one {count}');
    expect(pickForm('en', plural, { count: 0 })).toBe('many {count}');
    expect(pickForm('en', plural, { count: 2 })).toBe('many {count}');
    expect(pickForm('de', plural, { count: 1 })).toBe('one {count}');
    expect(pickForm('de', plural, { count: 5 })).toBe('many {count}');
  });

  it('uses `other` without a numeric count', () => {
    expect(pickForm('en', plural)).toBe('many {count}');
    expect(pickForm('en', plural, {})).toBe('many {count}');
    expect(pickForm('en', plural, { count: '1' })).toBe('many {count}');
  });

  it('falls back to `other` for a category the message does not define', () => {
    expect(pickForm('en', { other: 'only {count}' }, { count: 1 })).toBe('only {count}');
  });
});

describe('formatMessage', () => {
  it('replaces placeholders with strings', () => {
    expect(formatMessage('en', 'Hello {name}, bye {name}', { name: 'Ada' })).toBe(
      'Hello Ada, bye Ada',
    );
  });

  it('formats numbers for the locale', () => {
    expect(formatMessage('en', '{n} files', { n: 1234.5 })).toBe('1,234.5 files');
    expect(formatMessage('de', '{n} Dateien', { n: 1234.5 })).toBe('1.234,5 Dateien');
  });

  it('applies the plural form and then the count', () => {
    const message = { one: '{count} tool', other: '{count} tools' };
    expect(formatMessage('en', message, { count: 1 })).toBe('1 tool');
    expect(formatMessage('en', message, { count: 1200 })).toBe('1,200 tools');
    expect(formatMessage('de', message, { count: 1200 })).toBe('1.200 tools');
  });

  it('keeps a placeholder visible when its value is missing', () => {
    expect(formatMessage('en', '{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });

  it('ignores inherited property names such as toString', () => {
    expect(formatMessage('en', '{toString}', { a: 'x' })).toBe('{toString}');
  });

  it('returns the text when there are no parameters', () => {
    expect(formatMessage('en', 'no {params}')).toBe('no {params}');
  });

  it('does not treat braces that are not placeholders as such', () => {
    expect(formatMessage('en', '{ a } {1a}', { a: 'x', '1a': 'y' })).toBe('{ a } {1a}');
  });

  it('inserts values literally (no markup, no nested replacement)', () => {
    expect(formatMessage('en', '{a} {b}', { a: '{b}', b: '<b>' })).toBe('{b} <b>');
  });
});
