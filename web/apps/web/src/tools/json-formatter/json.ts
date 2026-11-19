/**
 * A JSON reader of our own: it keeps where every value sits (for the path under the cursor and for
 * error positions), keeps numbers as written (no precision lost on a large integer), tells which
 * non-standard JSON5 features a document uses, and reports errors in a form the page can word in
 * either language. It runs on the page and in a worker, so it must not touch the DOM.
 */

/** The deepest nesting accepted; the reader and the writer recurse once per level. */
export const MAX_DEPTH = 512;

/** What JSON5 allows that JSON does not; a strict read refuses each of them. */
export type JsonFeature =
  | 'comment'
  | 'trailingComma'
  | 'singleQuote'
  | 'unquotedKey'
  | 'number'
  | 'stringSyntax'
  | 'whitespace';

/** The order the page lists them in. */
export const JSON_FEATURES: readonly JsonFeature[] = [
  'comment',
  'trailingComma',
  'singleQuote',
  'unquotedKey',
  'number',
  'stringSyntax',
  'whitespace',
];

/** What the reader was waiting for when it met something else. */
export type JsonExpected =
  | 'value'
  | 'valueOrBracket'
  | 'key'
  | 'keyOrBrace'
  | 'colon'
  | 'commaOrBracket'
  | 'commaOrBrace'
  | 'end';

export type JsonErrorCode =
  | 'empty'
  | 'unexpectedEnd'
  | 'unexpectedChar'
  | 'badNumber'
  | 'badEscape'
  | 'badUnicode'
  | 'controlChar'
  | 'unterminatedString'
  | 'unterminatedComment'
  | 'tooDeep'
  | 'feature'
  | 'notRepresentable';

/** Why a text is not JSON, and where (`line` and `column` count from 1, in UTF-16 code units). */
export interface JsonError {
  readonly code: JsonErrorCode;
  /** Offset in the text (UTF-16 code units). */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  /** The character or word that was not expected, as it should be shown. */
  readonly found?: string;
  readonly expected?: JsonExpected;
  readonly feature?: JsonFeature;
}

interface Located {
  /** Offset of the first character of the value in the text. */
  readonly start: number;
  /** Offset after its last character. */
  readonly end: number;
}

export interface JsonMember extends Located {
  readonly key: string;
  readonly value: JsonNode;
}

export type JsonNode =
  | (Located & { readonly kind: 'null' })
  | (Located & { readonly kind: 'boolean'; readonly value: boolean })
  | (Located & { readonly kind: 'number'; readonly raw: string })
  | (Located & { readonly kind: 'string'; readonly value: string })
  | (Located & { readonly kind: 'array'; readonly items: readonly JsonNode[] })
  | (Located & { readonly kind: 'object'; readonly members: readonly JsonMember[] });

export type JsonParse =
  | { readonly ok: true; readonly node: JsonNode; readonly features: readonly JsonFeature[] }
  | { readonly ok: false; readonly error: JsonError };

export interface ParseOptions {
  /** Refuse everything JSON5 adds (comments, trailing commas, single quotes, ...). */
  readonly strict: boolean;
}

/** Line and column (from 1) of an offset; `\r\n`, `\n` and a lone `\r` end a line. */
export function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let index = 0; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || (code === 13 && text.charCodeAt(index + 1) !== 10)) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** A character the way an error message shows it: quoted, or `U+000A` for a control character. */
export function describeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029) {
    return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return char;
}

class Failure extends Error {
  constructor(
    readonly code: JsonErrorCode,
    readonly offset: number,
    readonly extra: {
      readonly found?: string;
      readonly expected?: JsonExpected;
      readonly feature?: JsonFeature;
    } = {},
  ) {
    super(code);
  }
}

const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const LOOSE_NUMBER = /^([+-]?)(0|[1-9]\d*)?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const HEX_NUMBER = /^([+-]?)0[xX]([0-9a-fA-F]+)$/;
const NUMBER_RUN = /[0-9A-Za-z.+-]/;
const IDENTIFIER_START = /^[\p{ID_Start}$_]$/u;
const IDENTIFIER_PART = /^[\p{ID_Continue}$‌‍]$/u;
const WORD_PART = /[\w$]/;
const JSON5_SPACE = new Set(['\v', '\f', '\u00a0', '\ufeff', '\u2028', '\u2029']);
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX2 = /^[0-9a-fA-F]{2}$/;

class Reader {
  position = 0;
  readonly features = new Set<JsonFeature>();

  constructor(
    readonly text: string,
    readonly strict: boolean,
  ) {}

  /** Records a JSON5 feature; a strict reader refuses it at `offset`. */
  feature(feature: JsonFeature, offset: number): void {
    if (this.strict) {
      throw new Failure('feature', offset, { feature });
    }
    this.features.add(feature);
  }

  peek(): string {
    return this.text.charAt(this.position);
  }

  fail(code: JsonErrorCode, offset = this.position, extra = {}): never {
    throw new Failure(code, offset, extra);
  }

  /** Fails at the current position: the end of the text, or the character found. */
  unexpected(expected: JsonExpected): never {
    if (this.position >= this.text.length) {
      return this.fail('unexpectedEnd', this.position, { expected });
    }
    return this.fail('unexpectedChar', this.position, { found: this.found(), expected });
  }

  /** The character at the position, or the whole word when it starts one. */
  found(): string {
    const start = this.position;
    let end = start;
    while (end < this.text.length && WORD_PART.test(this.text.charAt(end))) {
      end += 1;
    }
    return end - start > 1
      ? this.text.slice(start, Math.min(end, start + 24))
      : describeChar(this.char());
  }

  /** The code point at the position as a string. */
  char(): string {
    const point = this.text.codePointAt(this.position);
    return point === undefined ? '' : String.fromCodePoint(point);
  }

  skip(): void {
    const { text } = this;
    for (;;) {
      const char = this.peek();
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        this.position += 1;
      } else if (JSON5_SPACE.has(char)) {
        this.feature('whitespace', this.position);
        this.position += 1;
      } else if (char === '/' && text.charAt(this.position + 1) === '/') {
        this.feature('comment', this.position);
        this.position += 2;
        while (this.position < text.length && !'\n\r\u2028\u2029'.includes(this.peek())) {
          this.position += 1;
        }
      } else if (char === '/' && text.charAt(this.position + 1) === '*') {
        this.feature('comment', this.position);
        const close = text.indexOf('*/', this.position + 2);
        if (close === -1) {
          this.fail('unterminatedComment');
        }
        this.position = close + 2;
      } else {
        return;
      }
    }
  }

  value(depth: number): JsonNode {
    this.skip();
    const start = this.position;
    const char = this.peek();
    if (char === '{' || char === '[') {
      if (depth >= MAX_DEPTH) {
        this.fail('tooDeep');
      }
      return char === '{' ? this.object(depth) : this.array(depth);
    }
    if (char === '"' || char === "'") {
      const value = this.string();
      return { kind: 'string', value, start, end: this.position };
    }
    if (char === '-' || char === '+' || char === '.' || (char >= '0' && char <= '9')) {
      return this.number();
    }
    if (char !== '' && /[A-Za-z]/.test(char)) {
      return this.word();
    }
    return this.unexpected('value');
  }

  /** `true`, `false`, `null` (and the JSON5 numbers `Infinity` and `NaN`, which JSON cannot hold). */
  word(): JsonNode {
    const start = this.position;
    const word = this.found();
    this.position = start + word.length;
    if (word === 'true' || word === 'false') {
      return { kind: 'boolean', value: word === 'true', start, end: this.position };
    }
    if (word === 'null') {
      return { kind: 'null', start, end: this.position };
    }
    this.position = start;
    if (word === 'NaN' || word === 'Infinity') {
      return this.fail(this.strict ? 'unexpectedChar' : 'notRepresentable', start, {
        found: word,
        expected: 'value',
      });
    }
    return this.fail('unexpectedChar', start, { found: word, expected: 'value' });
  }

  number(): JsonNode {
    const { text } = this;
    const start = this.position;
    let end = start;
    // A sign may be followed by the word `Infinity` or `NaN`.
    while (end < text.length && NUMBER_RUN.test(text.charAt(end))) {
      end += 1;
    }
    const token = text.slice(start, end);
    this.position = end;
    if (STRICT_NUMBER.test(token)) {
      return { kind: 'number', raw: token, start, end };
    }
    const signless = token.replace(/^[+-]/, '');
    if (signless === 'Infinity' || signless === 'NaN') {
      this.position = start;
      return this.fail(this.strict ? 'badNumber' : 'notRepresentable', start, { found: token });
    }
    const raw = this.looseNumber(token);
    if (raw === undefined) {
      return this.fail('badNumber', start, {
        found: token.length > 24 ? token.slice(0, 24) : token,
      });
    }
    this.feature('number', start);
    return { kind: 'number', raw, start, end };
  }

  /** The JSON spelling of a JSON5 number (`+1`, `.5`, `5.`, `0x1F`), or `undefined` when it is none. */
  looseNumber(token: string): string | undefined {
    const hex = HEX_NUMBER.exec(token);
    if (hex !== null) {
      const digits = BigInt(`0x${hex[2] ?? '0'}`).toString();
      return hex[1] === '-' && digits !== '0' ? `-${digits}` : digits;
    }
    const match = LOOSE_NUMBER.exec(token);
    if (match === null) {
      return undefined;
    }
    const [, sign, integer, fraction, exponent] = match;
    if (integer === undefined && (fraction === undefined || fraction === '')) {
      return undefined;
    }
    const whole = integer ?? '0';
    const fractionPart = fraction === undefined || fraction === '' ? '' : `.${fraction}`;
    const exponentPart = exponent === undefined ? '' : `e${exponent}`;
    return `${sign === '-' ? '-' : ''}${whole}${fractionPart}${exponentPart}`;
  }

  /** A string in double or single quotes; the position ends after the closing quote. */
  string(): string {
    const { text } = this;
    const open = this.position;
    const quote = this.peek();
    if (quote === "'") {
      this.feature('singleQuote', open);
    }
    this.position += 1;
    const parts: string[] = [];
    let chunk = this.position;
    for (;;) {
      if (this.position >= text.length) {
        this.fail('unterminatedString', open);
      }
      const char = this.peek();
      if (char === quote) {
        parts.push(text.slice(chunk, this.position));
        this.position += 1;
        return parts.join('');
      }
      if (char === '\\') {
        parts.push(text.slice(chunk, this.position));
        parts.push(this.escape());
        chunk = this.position;
        continue;
      }
      if (char < ' ') {
        if (char === '\n' || char === '\r' || this.strict) {
          this.fail('controlChar', this.position, { found: describeChar(char) });
        }
        this.feature('stringSyntax', this.position);
      }
      this.position += 1;
    }
  }

  /** The text of the escape sequence at the position (a backslash); moves past it. */
  escape(): string {
    const { text } = this;
    const slash = this.position;
    const char = text.charAt(slash + 1);
    if (char === '') {
      return this.fail('unterminatedString', slash);
    }
    if (SIMPLE_ESCAPES.has(char)) {
      this.position = slash + 2;
      return JSON.parse(`"\\${char}"`) as string;
    }
    if (char === 'u') {
      const digits = text.slice(slash + 2, slash + 6);
      if (!HEX4.test(digits)) {
        this.fail('badUnicode', slash);
      }
      this.position = slash + 6;
      return String.fromCharCode(Number.parseInt(digits, 16));
    }
    // JSON5 escapes.
    this.feature('stringSyntax', slash);
    if (char === 'x') {
      const digits = text.slice(slash + 2, slash + 4);
      if (!HEX2.test(digits)) {
        this.fail('badUnicode', slash);
      }
      this.position = slash + 4;
      return String.fromCharCode(Number.parseInt(digits, 16));
    }
    if (char === "'") {
      this.position = slash + 2;
      return "'";
    }
    if (char === 'v') {
      this.position = slash + 2;
      return '\v';
    }
    if (char === '0' && !/\d/.test(text.charAt(slash + 2))) {
      this.position = slash + 2;
      return '\0';
    }
    if (char === '\r') {
      this.position = text.charAt(slash + 2) === '\n' ? slash + 3 : slash + 2;
      return '';
    }
    if (char === '\n' || char === '\u2028' || char === '\u2029') {
      this.position = slash + 2;
      return '';
    }
    return this.fail('badEscape', slash, { found: `\\${char}` });
  }

  key(): string {
    const char = this.peek();
    if (char === '"' || char === "'") {
      return this.string();
    }
    const start = this.position;
    const first = this.char();
    if (first === '' || !IDENTIFIER_START.test(first)) {
      return this.unexpected('key');
    }
    this.feature('unquotedKey', start);
    this.position += first.length;
    while (this.position < this.text.length) {
      const next = this.char();
      if (!IDENTIFIER_PART.test(next)) {
        break;
      }
      this.position += next.length;
    }
    return this.text.slice(start, this.position);
  }

  object(depth: number): JsonNode {
    const start = this.position;
    this.position += 1;
    const members: JsonMember[] = [];
    this.skip();
    if (this.peek() === '}') {
      this.position += 1;
      return { kind: 'object', members, start, end: this.position };
    }
    for (;;) {
      this.skip();
      const memberStart = this.position;
      const char = this.peek();
      if (char !== '"' && char !== "'" && !IDENTIFIER_START.test(this.char())) {
        this.unexpected(members.length === 0 ? 'keyOrBrace' : 'key');
      }
      const key = this.key();
      this.skip();
      if (this.peek() !== ':') {
        this.unexpected('colon');
      }
      this.position += 1;
      const value = this.value(depth + 1);
      members.push({ key, value, start: memberStart, end: value.end });
      this.skip();
      const next = this.peek();
      if (next === '}') {
        this.position += 1;
        return { kind: 'object', members, start, end: this.position };
      }
      if (next !== ',') {
        this.unexpected('commaOrBrace');
      }
      const comma = this.position;
      this.position += 1;
      this.skip();
      if (this.peek() === '}') {
        this.feature('trailingComma', comma);
        this.position += 1;
        return { kind: 'object', members, start, end: this.position };
      }
    }
  }

  array(depth: number): JsonNode {
    const start = this.position;
    this.position += 1;
    const items: JsonNode[] = [];
    this.skip();
    if (this.peek() === ']') {
      this.position += 1;
      return { kind: 'array', items, start, end: this.position };
    }
    for (;;) {
      const item = this.value(depth + 1);
      items.push(item);
      this.skip();
      const next = this.peek();
      if (next === ']') {
        this.position += 1;
        return { kind: 'array', items, start, end: this.position };
      }
      if (next !== ',') {
        this.unexpected('commaOrBracket');
      }
      const comma = this.position;
      this.position += 1;
      this.skip();
      if (this.peek() === ']') {
        this.feature('trailingComma', comma);
        this.position += 1;
        return { kind: 'array', items, start, end: this.position };
      }
    }
  }
}

/**
 * Reads a JSON document. Without `strict` it also reads what JSON5 adds (comments, trailing
 * commas, single quotes, unquoted keys, `+1` / `.5` / `0x1F`, more escapes) and says which of
 * those it met. Never throws: a problem comes back as `{ ok: false }`.
 */
export function parseJson(text: string, options: ParseOptions): JsonParse {
  const reader = new Reader(text, options.strict);
  // A byte order mark in front of a pasted file is not part of the document.
  reader.position = text.startsWith('\ufeff') ? 1 : 0;
  try {
    reader.skip();
    if (reader.position >= text.length) {
      reader.fail('empty', text.length);
    }
    const node = reader.value(0);
    reader.skip();
    if (reader.position < text.length) {
      reader.unexpected('end');
    }
    return { ok: true, node, features: JSON_FEATURES.filter((f) => reader.features.has(f)) };
  } catch (error: unknown) {
    if (!(error instanceof Failure)) {
      throw error;
    }
    const { line, column } = locate(text, error.offset);
    return {
      ok: false,
      error: { code: error.code, offset: error.offset, line, column, ...error.extra },
    };
  }
}

// -- writing -------------------------------------------------------------------------------

export interface FormatOptions {
  /** Spaces per level, `'tab'`, or 0 for one line without spaces. */
  readonly indent: number | 'tab';
  /** Sort the keys of every object (by UTF-16 code unit order). */
  readonly sortKeys: boolean;
}

function compareKeys(a: JsonMember, b: JsonMember): number {
  if (a.key === b.key) {
    return 0;
  }
  return a.key < b.key ? -1 : 1;
}

/** Writes a document as JSON text (strict, with the numbers exactly as read). */
export function formatJson(node: JsonNode, options: FormatOptions): string {
  const unit = options.indent === 'tab' ? '\t' : ' '.repeat(options.indent);
  const compact = options.indent === 0;
  const write = (current: JsonNode, level: number): string => {
    switch (current.kind) {
      case 'null':
        return 'null';
      case 'boolean':
        return current.value ? 'true' : 'false';
      case 'number':
        return current.raw;
      case 'string':
        return JSON.stringify(current.value);
      case 'array': {
        if (current.items.length === 0) {
          return '[]';
        }
        const inner = current.items.map((item) => write(item, level + 1));
        return compact ? `[${inner.join(',')}]` : wrap('[', ']', inner, level);
      }
      case 'object': {
        if (current.members.length === 0) {
          return '{}';
        }
        const members = options.sortKeys ? [...current.members].sort(compareKeys) : current.members;
        const colon = compact ? ':' : ': ';
        const inner = members.map(
          (member) => `${JSON.stringify(member.key)}${colon}${write(member.value, level + 1)}`,
        );
        return compact ? `{${inner.join(',')}}` : wrap('{', '}', inner, level);
      }
    }
  };
  const wrap = (open: string, close: string, inner: readonly string[], level: number): string => {
    const pad = unit.repeat(level + 1);
    return `${open}\n${inner.map((line) => `${pad}${line}`).join(',\n')}\n${unit.repeat(level)}${close}`;
  };
  return write(node, 0);
}

// -- values --------------------------------------------------------------------------------

/** A plain JavaScript value as `JSON.parse` would make it (duplicate keys: the last one wins). */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Integers beyond this lose digits when they become a JavaScript number. */
export function losesPrecision(raw: string): boolean {
  if (!/^-?\d+$/.test(raw)) {
    return false;
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) {
    // Too large for any JavaScript number (and for `BigInt(number)` below).
    return true;
  }
  return !Number.isSafeInteger(number) && BigInt(raw) !== BigInt(number);
}

/** The value of a node; a key such as `__proto__` becomes a plain own property. */
export function toValue(node: JsonNode): JsonValue {
  switch (node.kind) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
      return node.value;
    case 'number':
      return Number(node.raw);
    case 'array':
      return node.items.map(toValue);
    case 'object': {
      const result: Record<string, JsonValue> = {};
      for (const member of node.members) {
        Object.defineProperty(result, member.key, {
          value: toValue(member.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
  }
}

export interface JsonStats {
  readonly depth: number;
  readonly objects: number;
  readonly arrays: number;
  readonly strings: number;
  readonly numbers: number;
  readonly booleans: number;
  readonly nulls: number;
  readonly keys: number;
  /** Keys that occur twice in the same object (only the last one counts for `JSON.parse`). */
  readonly duplicateKeys: number;
  /** Integers that a JavaScript number cannot hold exactly. */
  readonly bigNumbers: number;
}

export function statsOf(root: JsonNode): JsonStats {
  const counts = {
    depth: 0,
    objects: 0,
    arrays: 0,
    strings: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    keys: 0,
    duplicateKeys: 0,
    bigNumbers: 0,
  };
  const visit = (node: JsonNode, depth: number): void => {
    counts.depth = Math.max(counts.depth, depth);
    switch (node.kind) {
      case 'null':
        counts.nulls += 1;
        break;
      case 'boolean':
        counts.booleans += 1;
        break;
      case 'string':
        counts.strings += 1;
        break;
      case 'number':
        counts.numbers += 1;
        if (losesPrecision(node.raw)) {
          counts.bigNumbers += 1;
        }
        break;
      case 'array':
        counts.arrays += 1;
        for (const item of node.items) {
          visit(item, depth + 1);
        }
        break;
      case 'object': {
        counts.objects += 1;
        const seen = new Set<string>();
        for (const member of node.members) {
          counts.keys += 1;
          if (seen.has(member.key)) {
            counts.duplicateKeys += 1;
          }
          seen.add(member.key);
          visit(member.value, depth + 1);
        }
      }
    }
  };
  visit(root, 1);
  return counts;
}

// -- paths ---------------------------------------------------------------------------------

export type PathSegment = string | number;

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

/** `$.a[0]["b c"]`: the path of a value, the way JSONPath writes it. */
export function formatPath(segments: readonly PathSegment[]): string {
  return segments.reduce<string>((path, segment) => {
    if (typeof segment === 'number') {
      return `${path}[${String(segment)}]`;
    }
    return PLAIN_KEY.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
  }, '$');
}

/**
 * The path of the innermost value that holds `offset` (a key counts for its value). Between two
 * values, or outside the document, it is the closest enclosing value.
 */
export function pathAt(root: JsonNode, offset: number): readonly PathSegment[] {
  const path: PathSegment[] = [];
  let node = root;
  for (;;) {
    if (node.kind === 'array') {
      const index = node.items.findIndex((item) => offset >= item.start && offset <= item.end);
      const item = node.items[index];
      if (item === undefined) {
        return path;
      }
      path.push(index);
      node = item;
    } else if (node.kind === 'object') {
      const index = node.members.findLastIndex(
        (member) => offset >= member.start && offset <= member.end,
      );
      const member = node.members[index];
      if (member === undefined) {
        return path;
      }
      path.push(member.key);
      node = member.value;
      if (offset < node.start) {
        return path;
      }
    } else {
      return path;
    }
  }
}

export type PathParse =
  | { readonly ok: true; readonly segments: readonly PathSegment[] }
  | { readonly ok: false; readonly offset: number };

/**
 * Reads a path: an optional `$`, then `.name`, `[0]`, `["name"]` or `['name']` in any order; a
 * leading `name` without a dot is allowed. The empty text and `$` are the whole document.
 */
export function parsePath(text: string): PathParse {
  const source = text.trim();
  const segments: PathSegment[] = [];
  let position = source.startsWith('$') ? 1 : 0;
  const fail = (offset: number): PathParse => ({ ok: false, offset });
  let first = position === 0;
  while (position < source.length) {
    const char = source.charAt(position);
    if (char === '.' || (first && PLAIN_KEY.test(char))) {
      const start = char === '.' ? position + 1 : position;
      let end = start;
      while (end < source.length && /[\w$]/.test(source.charAt(end))) {
        end += 1;
      }
      const name = source.slice(start, end);
      if (!PLAIN_KEY.test(name)) {
        // A name that is only digits is an index: `a.0`.
        if (/^\d+$/.test(name)) {
          segments.push(Number(name));
          position = end;
          first = false;
          continue;
        }
        return fail(start);
      }
      segments.push(name);
      position = end;
    } else if (char === '[') {
      const quote = source.charAt(position + 1);
      if (quote === '"' || quote === "'") {
        const parsed = readQuoted(source, position + 1);
        if (parsed === undefined || source.charAt(parsed.end) !== ']') {
          return fail(position + 1);
        }
        segments.push(parsed.value);
        position = parsed.end + 1;
      } else {
        const close = source.indexOf(']', position);
        const digits = close === -1 ? '' : source.slice(position + 1, close);
        if (!/^\d+$/.test(digits)) {
          return fail(position + 1);
        }
        segments.push(Number(digits));
        position = close + 1;
      }
    } else {
      return fail(position);
    }
    first = false;
  }
  return { ok: true, segments };
}

function readQuoted(source: string, start: number): { value: string; end: number } | undefined {
  const quote = source.charAt(start);
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (char === quote) {
      return { value, end: index + 1 };
    }
    if (char === '\\') {
      index += 1;
      const escaped = source.charAt(index);
      if (escaped === '') {
        return undefined;
      }
      value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
    } else {
      value += char;
    }
  }
  return undefined;
}

/** The value at a path, or `undefined` when the document has nothing there. */
export function valueAt(root: JsonNode, segments: readonly PathSegment[]): JsonNode | undefined {
  let node: JsonNode | undefined = root;
  for (const segment of segments) {
    if (node === undefined) {
      return undefined;
    }
    if (typeof segment === 'number') {
      node = node.kind === 'array' ? node.items[segment] : undefined;
    } else {
      // With a duplicate key the last one is the one `JSON.parse` keeps.
      node =
        node.kind === 'object'
          ? node.members.findLast((member) => member.key === segment)?.value
          : undefined;
    }
  }
  return node;
}
