export { i18n, I18n, t } from './i18n.svelte.ts';
export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  detectLocale,
  isLocale,
  matchLocale,
  type Locale,
} from './locales.ts';
export type { MessageKey } from './messages/en.ts';
export type { Message, MessageParams } from './types.ts';
