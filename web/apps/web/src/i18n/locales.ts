/** Locales the UI ships with; the first entry of a browser's language list that matches wins. */
export const LOCALES = ['de', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/** Used when neither a stored choice nor the browser's languages match a shipped locale. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Each locale's own name (shown in the language switch, never translated). */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  de: 'Deutsch',
  en: 'English',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Maps a BCP 47 tag such as `de-AT` or `EN_us` to a shipped locale by its primary subtag. */
export function matchLocale(tag: string): Locale | undefined {
  const primary = tag.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  return isLocale(primary) ? primary : undefined;
}

/** First match of the browser's preference list (`navigator.languages`), else the default. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const locale = matchLocale(tag);
    if (locale !== undefined) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}
