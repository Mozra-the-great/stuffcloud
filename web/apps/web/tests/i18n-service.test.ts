import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOGS,
  I18n,
  LOCALE_STORAGE_KEY,
  browserEnvironment,
  i18n,
  t,
  type I18nEnvironment,
} from '../src/i18n/i18n.svelte.ts';
import type { Locale } from '../src/i18n/locales.ts';
import type { Catalog } from '../src/i18n/types.ts';

function memoryStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function environment(overrides: Partial<I18nEnvironment> = {}): I18nEnvironment {
  return { languages: ['en'], storage: undefined, root: undefined, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

describe('I18n initial language', () => {
  it('follows the browser language list', () => {
    expect(new I18n(environment({ languages: ['de-DE', 'en'] })).locale).toBe('de');
    expect(new I18n(environment({ languages: ['fr'] })).locale).toBe('en');
  });

  it('prefers a stored manual choice over the browser', () => {
    const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'en' });
    expect(new I18n(environment({ languages: ['de'], storage })).locale).toBe('en');
  });

  it('ignores a stored value that is not a shipped locale', () => {
    const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'fr' });
    expect(new I18n(environment({ languages: ['de'], storage })).locale).toBe('de');
  });

  it('survives a storage that throws', () => {
    const storage = {
      getItem: (): string => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    const service = new I18n(environment({ languages: ['de'], storage }));
    expect(service.locale).toBe('de');
    expect(() => {
      service.setLocale('en');
    }).not.toThrow();
    expect(service.locale).toBe('en');
  });

  it('sets the lang attribute of the root element', () => {
    const root = document.createElement('html');
    new I18n(environment({ languages: ['de'], root }));
    expect(root.getAttribute('lang')).toBe('de');
  });
});

describe('I18n.setLocale', () => {
  it('switches the language, the root lang and remembers the choice', () => {
    const root = document.createElement('html');
    const storage = memoryStorage();
    const service = new I18n(environment({ root, storage }));

    service.setLocale('de');

    expect(service.locale).toBe('de');
    expect(root.getAttribute('lang')).toBe('de');
    expect(storage.data[LOCALE_STORAGE_KEY]).toBe('de');
    expect(service.t('nav.menuOpen')).toBe('Menü öffnen');
    service.setLocale('en');
    expect(service.t('nav.menuOpen')).toBe('Open menu');
  });
});

describe('I18n.t', () => {
  it('translates, interpolates and pluralises', () => {
    const service = new I18n(environment());
    expect(service.t('status.navigated', { title: 'Tools' })).toBe('Navigated to Tools');
    expect(service.t('tools.count', { count: 1 })).toBe('1 tool');
    expect(service.t('tools.count', { count: 3 })).toBe('3 tools');
    service.setLocale('de');
    expect(service.t('status.navigated', { title: 'Tools' })).toBe('Gewechselt zu Tools');
    expect(service.t('search.count', { count: 1 })).toBe('1 Tool gefunden');
    expect(service.t('search.count', { count: 2000 })).toBe('2.000 Tools gefunden');
  });

  it('falls back to English, then to the key', () => {
    const partial: Record<Locale, Catalog> = {
      en: { 'nav.tools': 'Tools EN', 'nav.main': 'Main EN' },
      de: { 'nav.tools': 'Tools DE' },
    };
    const service = new I18n(environment({ languages: ['de'] }), partial);
    expect(service.t('nav.tools')).toBe('Tools DE');
    expect(service.t('nav.main')).toBe('Main EN');
    expect(service.t('nav.menuOpen')).toBe('nav.menuOpen');
  });

  it('is available through the module-level helper', () => {
    i18n.setLocale('de');
    expect(t('nav.tools')).toBe(CATALOGS.de['nav.tools']);
  });
});

describe('I18n number and date formatting', () => {
  it('formats numbers for the current language', () => {
    const service = new I18n(environment());
    expect(service.number(1234567.891)).toBe('1,234,567.891');
    service.setLocale('de');
    expect(service.number(1234567.891)).toBe('1.234.567,891');
    expect(service.number(0.5, { style: 'percent' })).toBe('50 %');
  });

  it('formats dates for the current language (medium style by default)', () => {
    const date = new Date(Date.UTC(2026, 10, 19, 12));
    const service = new I18n(environment());
    expect(service.date(date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Nov 19, 2026');
    service.setLocale('de');
    expect(service.date(date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe('19.11.2026');
    expect(service.date(date.getTime())).toMatch(/2026/);
  });
});

describe('browserEnvironment', () => {
  it('reads languages, storage and the root element from the window', () => {
    const env = browserEnvironment();
    expect(env.languages.length).toBeGreaterThan(0);
    expect(env.root).toBe(document.documentElement);
    expect(env.storage).toBe(window.localStorage);
  });

  it('uses the single language when the list is empty', () => {
    const win = {
      navigator: { languages: [], language: 'de-DE' },
      document,
      get localStorage(): Storage {
        return window.localStorage;
      },
    } as unknown as Window;
    expect(browserEnvironment(win).languages).toEqual(['de-DE']);
  });

  it('has no storage when access to it throws', () => {
    const win = {
      navigator: { languages: ['en'], language: 'en' },
      document,
      get localStorage(): Storage {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Window;
    expect(browserEnvironment(win).storage).toBeUndefined();
  });
});
