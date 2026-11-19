import { i18n, t, type MessageKey } from '../../i18n/index.ts';
import { describeChar, type JsonErrorCode, type JsonExpected } from '../json-formatter/json.ts';
import { jsonProblemText, shown } from '../json-formatter/messages.ts';
import type { ConvertError, Format } from './convert.ts';

export const FORMAT_KEYS: Readonly<Record<Format, MessageKey>> = {
  json: 'convert.format.json',
  yaml: 'convert.format.yaml',
  xml: 'convert.format.xml',
};

const XML_READ_KEYS: Readonly<Record<string, MessageKey>> = {
  empty: 'xml.error.empty',
  noRoot: 'xml.error.noRoot',
  multipleRoots: 'xml.error.multipleRoots',
  textOutsideRoot: 'xml.error.textOutsideRoot',
  unexpectedEnd: 'xml.error.unexpectedEnd',
  unterminated: 'xml.error.unterminated',
  mismatchedTag: 'xml.error.mismatchedTag',
  badName: 'xml.error.badName',
  badAttribute: 'xml.error.badAttribute',
  duplicateAttribute: 'xml.error.duplicateAttribute',
  badReference: 'xml.error.badReference',
  badCharacter: 'xml.error.badCharacter',
  dtd: 'xml.error.dtd',
  tooDeep: 'xml.error.tooDeep',
};

const XML_WRITE_KEYS: Readonly<Record<string, MessageKey>> = {
  badName: 'xml.write.badName',
  badCharacter: 'xml.write.badCharacter',
  nestedArray: 'xml.write.nestedArray',
  attributeValue: 'xml.write.attributeValue',
  tooDeep: 'xml.write.tooDeep',
};

const LIMIT_KEYS: Readonly<Record<string, MessageKey>> = {
  inputTooLarge: 'convert.error.inputTooLarge',
  tooDeep: 'convert.error.tooDeep',
  tooManyValues: 'convert.error.tooManyValues',
  tooLarge: 'convert.error.tooLarge',
};

const WRITE_KEYS: Readonly<Record<string, MessageKey>> = {
  notFinite: 'convert.error.notFinite',
  notData: 'convert.error.notData',
};

function number(value: number | undefined): string {
  return new Intl.NumberFormat(i18n.locale).format(value ?? 0);
}

/** An element name the way a tag shows it. */
function tag(name: string | undefined): string {
  return `<${name ?? ''}>`;
}

/** The problem in words, without its position. */
function problemText(error: ConvertError): string {
  const params = {
    max: number(error.max),
    path: error.path ?? '$',
    found: error.found ?? '',
  };
  if (error.where === 'limit') {
    return t(LIMIT_KEYS[error.code] ?? 'convert.error.tooLarge', params);
  }
  if (error.where === 'write') {
    const key =
      (error.format === 'xml' ? XML_WRITE_KEYS[error.code] : undefined) ?? WRITE_KEYS[error.code];
    return t(key ?? 'convert.error.notData', {
      ...params,
      found: error.code === 'badName' ? shown(params.found) : params.found,
    });
  }
  if (error.format === 'json') {
    return jsonProblemText({
      code: error.code as JsonErrorCode,
      ...(error.found === undefined ? {} : { found: error.found }),
      ...(error.expected === undefined ? {} : { expected: error.expected as JsonExpected }),
      ...(error.max === undefined ? {} : { max: error.max }),
    });
  }
  if (error.format === 'yaml') {
    if (error.code === 'empty') {
      return t('yaml.error.empty');
    }
    if (error.code === 'tooDeep') {
      return t('yaml.error.tooDeep', params);
    }
    if (error.code === 'aliasLimit') {
      return t('yaml.error.aliasLimit', params);
    }
    // The reader's own wording (English only).
    return error.detail ?? error.code;
  }
  if (error.code === 'badName' && error.found === undefined) {
    return t('xml.error.badNameEnd');
  }
  if (error.code === 'mismatchedTag' && error.expected === undefined) {
    return t('xml.error.unmatchedClose', { found: tag(error.found) });
  }
  const found =
    error.code === 'unexpectedEnd' || error.code === 'mismatchedTag'
      ? tag(error.found)
      : error.code === 'badCharacter'
        ? shown(describeChar(error.found ?? ''))
        : (error.found ?? '');
  return t(XML_READ_KEYS[error.code] ?? 'xml.error.unterminated', {
    ...params,
    found,
    expected: tag(error.expected),
  });
}

/** What the visitor reads when a conversion fails: the problem, where it is, and in which format. */
export function convertErrorText(error: ConvertError): string {
  const message = problemText(error);
  const located =
    error.line === undefined || error.column === undefined
      ? message
      : t('convert.error.at', { message, line: error.line, column: error.column });
  if (error.where === 'limit') {
    return located;
  }
  return t(error.where === 'read' ? 'convert.error.read' : 'convert.error.write', {
    format: t(FORMAT_KEYS[error.format]),
    message: located,
  });
}
