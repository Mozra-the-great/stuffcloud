import { DEFAULT_LOCALE, detectLocale, isLocale, type Locale } from './locales.ts';
import { de } from './messages/de.ts';
import { en, type MessageKey } from './messages/en.ts';
import { formatMessage } from './translate.ts';
import type { Catalog, MessageParams } from './types.ts';

export const CATALOGS: Readonly<Record<Locale, Catalog>> = { de, en };

/** Where the manual language choice is remembered (this browser only; a preference, not tracking). */
export const LOCALE_STORAGE_KEY = 'stuffcloud.locale';

/** What the language service needs from the browser, injectable for tests. */
export interface I18nEnvironment {
  /** The browser's language preference list, most preferred first. */
  readonly languages: readonly string[];
  /** Missing (or throwing) storage only means the choice is not remembered. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  /** Element whose `lang` attribute follows the locale (the `<html>` element). */
  readonly root: HTMLElement | undefined;
}

function storageOf(win: Window): I18nEnvironment['storage'] {
  try {
    return win.localStorage;
  } catch {
    return undefined;
  }
}

export function browserEnvironment(win: Window = window): I18nEnvironment {
  return {
    languages:
      win.navigator.languages.length > 0 ? win.navigator.languages : [win.navigator.language],
    storage: storageOf(win),
    root: win.document.documentElement,
  };
}

/**
 * The UI language: the stored manual choice, else the browser's preference, else English.
 * `locale` is reactive, so every `t()` call inside a template re-renders when it changes (no reload).
 */
export class I18n {
  readonly #environment: I18nEnvironment;
  readonly #catalogs: Readonly<Record<Locale, Catalog>>;
  #locale = $state<Locale>(DEFAULT_LOCALE);

  constructor(
    environment: I18nEnvironment,
    catalogs: Readonly<Record<Locale, Catalog>> = CATALOGS,
  ) {
    this.#environment = environment;
    this.#catalogs = catalogs;
    this.#locale = this.#initialLocale();
    this.#syncRoot();
  }

  get locale(): Locale {
    return this.#locale;
  }

  /** Switches the language at once and remembers the choice. */
  setLocale(locale: Locale): void {
    this.#locale = locale;
    this.#syncRoot();
    try {
      this.#environment.storage?.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Storage full or blocked: the choice just is not remembered.
    }
  }

  /** Text for `key` in the current locale; falls back to English, then to the key itself. */
  t(key: MessageKey, params?: MessageParams): string {
    const locale = this.#locale;
    const message = this.#catalogs[locale][key] ?? this.#catalogs[DEFAULT_LOCALE][key];
    return message === undefined ? key : formatMessage(locale, message, params);
  }

  number(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.#locale, options).format(value);
  }

  /** Medium date by default (`19 Nov 2026` / `19.11.2026`); pass options for anything else. */
  date(
    value: Date | number,
    options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  ): string {
    return new Intl.DateTimeFormat(this.#locale, options).format(value);
  }

  #initialLocale(): Locale {
    const stored = this.#readStored();
    return stored !== undefined && isLocale(stored)
      ? stored
      : detectLocale(this.#environment.languages);
  }

  #readStored(): string | undefined {
    try {
      return this.#environment.storage?.getItem(LOCALE_STORAGE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  #syncRoot(): void {
    this.#environment.root?.setAttribute('lang', this.#locale);
  }
}

/** The app-wide instance. */
export const i18n = new I18n(browserEnvironment());

export function t(key: MessageKey, params?: MessageParams): string {
  return i18n.t(key, params);
}
