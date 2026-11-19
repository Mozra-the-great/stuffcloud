import type { MessageKey } from '../../i18n/index.ts';
import type { ColorErrorCode, ContrastCheckId } from './color.ts';

/** The message of every reason a text is not a colour. */
export const ERROR_KEYS: Readonly<Record<ColorErrorCode, MessageKey>> = {
  empty: 'color.error.empty',
  unknown: 'color.error.unknown',
  syntax: 'color.error.syntax',
  range: 'color.error.range',
  alpha: 'color.error.alpha',
};

/** The name of every contrast check. */
export const CHECK_KEYS: Readonly<Record<ContrastCheckId, MessageKey>> = {
  'aa-normal': 'color.contrast.aaNormal',
  'aa-large': 'color.contrast.aaLarge',
  'aaa-normal': 'color.contrast.aaaNormal',
  'aaa-large': 'color.contrast.aaaLarge',
  ui: 'color.contrast.ui',
};
