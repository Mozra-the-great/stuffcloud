import { i18n, t, type MessageKey } from '../../i18n/index.ts';
import type { JsonError, JsonErrorCode, JsonExpected, JsonFeature } from './json.ts';

const EXPECTED_KEYS: Readonly<Record<JsonExpected, MessageKey>> = {
  value: 'json.expected.value',
  valueOrBracket: 'json.expected.valueOrBracket',
  key: 'json.expected.key',
  keyOrBrace: 'json.expected.keyOrBrace',
  colon: 'json.expected.colon',
  commaOrBracket: 'json.expected.commaOrBracket',
  commaOrBrace: 'json.expected.commaOrBrace',
  end: 'json.expected.end',
};

export const FEATURE_KEYS: Readonly<Record<JsonFeature, MessageKey>> = {
  comment: 'json.feature.comment',
  trailingComma: 'json.feature.trailingComma',
  singleQuote: 'json.feature.singleQuote',
  unquotedKey: 'json.feature.unquotedKey',
  number: 'json.feature.number',
  stringSyntax: 'json.feature.stringSyntax',
  whitespace: 'json.feature.whitespace',
};

const ERROR_KEYS: Readonly<Record<JsonErrorCode, MessageKey>> = {
  empty: 'json.error.empty',
  unexpectedEnd: 'json.error.unexpectedEnd',
  unexpectedChar: 'json.error.unexpectedChar',
  badNumber: 'json.error.badNumber',
  badEscape: 'json.error.badEscape',
  badUnicode: 'json.error.badUnicode',
  controlChar: 'json.error.controlChar',
  unterminatedString: 'json.error.unterminatedString',
  unterminatedComment: 'json.error.unterminatedComment',
  tooDeep: 'json.error.tooDeep',
  feature: 'json.error.feature',
  notRepresentable: 'json.error.notRepresentable',
};

/** The error as a visitor reads it: a character is quoted, a code point (`U+000A`) is not. */
export function shown(found: string): string {
  return found.startsWith('U+') ? found : `“${found}”`;
}

/** What is wrong, without the position. */
export function jsonProblemText(
  error: Pick<JsonError, 'code' | 'found' | 'expected' | 'feature'> & { readonly max?: number },
): string {
  return t(ERROR_KEYS[error.code], {
    found: shown(error.found ?? ''),
    expected: t(EXPECTED_KEYS[error.expected ?? 'value']),
    feature: t(FEATURE_KEYS[error.feature ?? 'comment']),
    max: new Intl.NumberFormat(i18n.locale).format(error.max ?? 0),
  });
}

/** What is wrong and where: "Unexpected ... (line 3, column 5)". */
export function jsonErrorText(
  error: Pick<JsonError, 'code' | 'found' | 'expected' | 'feature' | 'line' | 'column'> & {
    readonly max?: number;
  },
): string {
  return t('json.error.at', {
    message: jsonProblemText(error),
    line: error.line,
    column: error.column,
  });
}

/** "comments, trailing commas and unquoted keys". */
export function featureList(features: readonly JsonFeature[]): string {
  return new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(
    features.map((feature) => t(FEATURE_KEYS[feature])),
  );
}
