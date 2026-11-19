import type { MessageKey } from '../../i18n/index.ts';
import type { CronErrorCode, CronFieldName } from './cron.ts';

/** The message of every reason a text is not a CRON expression. */
export const ERROR_KEYS: Readonly<Record<CronErrorCode, MessageKey>> = {
  empty: 'cron.error.empty',
  'too-long': 'cron.error.tooLong',
  'field-count': 'cron.error.fieldCount',
  'unknown-macro': 'cron.error.unknownMacro',
  reboot: 'cron.error.reboot',
  'empty-item': 'cron.error.emptyItem',
  syntax: 'cron.error.syntax',
  'out-of-range': 'cron.error.outOfRange',
  'range-order': 'cron.error.rangeOrder',
  'step-zero': 'cron.error.stepZero',
  'step-too-large': 'cron.error.stepTooLarge',
  'unsupported-special': 'cron.error.unsupportedSpecial',
  'bad-nth': 'cron.error.badNth',
};

/** The name of every field, for the error messages. */
export const FIELD_KEYS: Readonly<Record<CronFieldName, MessageKey>> = {
  second: 'cron.field.second',
  minute: 'cron.field.minute',
  hour: 'cron.field.hour',
  dayOfMonth: 'cron.field.dayOfMonth',
  month: 'cron.field.month',
  dayOfWeek: 'cron.field.dayOfWeek',
  year: 'cron.field.year',
};
