/**
 * An XML reader and writer of our own, for the converter. XML is read into plain objects the way
 * `fast-xml-parser` does by default (`@_name` for an attribute, `#text` for the text of an element
 * that also has attributes or children, repeated elements become an array), and written back from
 * the same shape.
 *
 * What it does not do, on purpose:
 * - **No DTD, no entities of its own.** A `<!DOCTYPE>` with an internal subset (`[ ... ]`, where
 *   `<!ENTITY>` lives) is refused, and a `<!DOCTYPE>` without one is skipped: an external DTD or
 *   entity is never fetched (nothing here can fetch). Only the five predefined entities and
 *   character references are known, so a "billion laughs" document cannot expand.
 * - No namespace processing: `a:b` is simply a name.
 * - Comments, processing instructions and the XML declaration are dropped.
 *
 * It nests at most {@link MAX_XML_DEPTH} levels, reads without recursion and must not touch the DOM
 * (it also runs in a worker, where `DOMParser` does not exist).
 */

export const MAX_XML_DEPTH = 512;

export const ATTRIBUTE_PREFIX = '@_';
export const TEXT_KEY = '#text';

export type XmlValue = string | XmlObject | readonly XmlValue[];
export interface XmlObject {
  readonly [key: string]: XmlValue;
}

export type XmlErrorCode =
  | 'empty'
  | 'noRoot'
  | 'multipleRoots'
  | 'textOutsideRoot'
  | 'unexpectedEnd'
  | 'unterminated'
  | 'mismatchedTag'
  | 'badName'
  | 'badAttribute'
  | 'duplicateAttribute'
  | 'badReference'
  | 'badCharacter'
  | 'dtd'
  | 'tooDeep';

/** What is wrong with a document, and where (`line` and `column` count from 1). */
export interface XmlError {
  readonly code: XmlErrorCode;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  /** The name, reference or character the problem is about. */
  readonly found?: string;
  /** For a mismatched closing tag: the element that was open. */
  readonly expected?: string;
}

export type XmlParse =
  | { readonly ok: true; readonly value: XmlObject }
  | { readonly ok: false; readonly error: XmlError };

// -- characters ----------------------------------------------------------------------------

/** A range of a character class, written with code point escapes. */
function span(from: number, to: number): string {
  return `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`;
}

// The characters XML 1.0 (fifth edition) allows in a name. Built from numbers: the combining
// marks of NameChar would trip the "misleading character class" lint rule as a literal.
const NAME_START = [
  ':A-Z_a-z',
  span(0xc0, 0xd6),
  span(0xd8, 0xf6),
  span(0xf8, 0x2ff),
  span(0x370, 0x37d),
  span(0x37f, 0x1fff),
  span(0x200c, 0x200d),
  span(0x2070, 0x218f),
  span(0x2c00, 0x2fef),
  span(0x3001, 0xd7ff),
  span(0xf900, 0xfdcf),
  span(0xfdf0, 0xfffd),
  span(0x10000, 0xeffff),
].join('');
const NAME_CHAR = `${NAME_START}\\-.0-9${span(0xb7, 0xb7)}${span(0x300, 0x36f)}${span(0x203f, 0x2040)}`;
const NAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u');
const NAME_AT = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy');
const BAD_CHARACTER = /[^\t\n\r -\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
const SPACE = /[ \t\r\n]/;
const REFERENCE = /^&([^\s;&<]*);/;
const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** Whether `text` is a valid XML name (an element or attribute name). */
export function isXmlName(text: string): boolean {
  return NAME.test(text);
}

/** The offset of the first character XML 1.0 does not allow, or -1. */
export function badCharacterAt(text: string): number {
  return text.search(BAD_CHARACTER);
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || (code === 13 && text.charCodeAt(index + 1) !== 10)) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Sets an own property, also for a name such as `__proto__`. */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

class Failure extends Error {
  constructor(
    readonly code: XmlErrorCode,
    readonly offset: number,
    readonly found?: string,
    readonly expected?: string,
  ) {
    super(code);
  }
}

// -- reading -------------------------------------------------------------------------------

interface Frame {
  readonly name: string;
  readonly attributes: [string, string][];
  readonly children: [string, XmlValue][];
  readonly text: string[];
}

/** An element as a value: a string when it has nothing but text, an object otherwise. */
function finish(frame: Frame): XmlValue {
  const { attributes, children, text } = frame;
  if (attributes.length === 0 && children.length === 0) {
    return text.join('');
  }
  const result: Record<string, XmlValue> = {};
  for (const [name, value] of attributes) {
    setOwn(result, `${ATTRIBUTE_PREFIX}${name}`, value);
  }
  addChildren(result, children);
  const content =
    children.length === 0
      ? text.join('')
      : text
          .map((piece) => piece.trim())
          .filter((piece) => piece !== '')
          .join(' ');
  if (content.trim() !== '') {
    setOwn(result, TEXT_KEY, content);
  }
  return result;
}

/** Child elements by name, in the order each name first appears; repeats become an array. */
function addChildren(
  target: Record<string, XmlValue>,
  children: readonly [string, XmlValue][],
): void {
  const groups = new Map<string, XmlValue[]>();
  for (const [name, value] of children) {
    const group = groups.get(name);
    if (group === undefined) {
      groups.set(name, [value]);
    } else {
      group.push(value);
    }
  }
  for (const [name, group] of groups) {
    setOwn(target, name, group.length === 1 ? (group[0] ?? '') : group);
  }
}

/** Replaces the references in `raw` (text or an attribute value); `base` is where `raw` starts. */
function decode(raw: string, base: number): string {
  if (!raw.includes('&')) {
    return raw;
  }
  let result = '';
  let position = 0;
  for (;;) {
    const amp = raw.indexOf('&', position);
    if (amp === -1) {
      return result + raw.slice(position);
    }
    result += raw.slice(position, amp);
    const match = REFERENCE.exec(raw.slice(amp, amp + 40));
    if (match === null) {
      throw new Failure(
        'badReference',
        base + amp,
        /^&[^\s;&<]*/.exec(raw.slice(amp, amp + 40))?.[0],
      );
    }
    const reference = match[0];
    const body = match[1] ?? '';
    const semicolon = amp + reference.length - 1;
    const predefined = PREDEFINED.get(body);
    if (predefined !== undefined) {
      result += predefined;
    } else if (/^#(?:\d+|x[0-9a-fA-F]+)$/.test(body)) {
      const point = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (point > 0x10ffff || badCharacterAt(String.fromCodePoint(point)) !== -1) {
        throw new Failure('badReference', base + amp, reference);
      }
      result += String.fromCodePoint(point);
    } else {
      throw new Failure('badReference', base + amp, reference);
    }
    position = semicolon + 1;
  }
}

class Reader {
  position = 0;

  constructor(readonly text: string) {}

  fail(code: XmlErrorCode, offset = this.position, found?: string, expected?: string): never {
    throw new Failure(code, offset, found, expected);
  }

  skipSpace(): void {
    while (this.position < this.text.length && SPACE.test(this.text.charAt(this.position))) {
      this.position += 1;
    }
  }

  /** The name at the position; fails with `badName` when there is none. */
  name(): string {
    NAME_AT.lastIndex = this.position;
    const match = NAME_AT.exec(this.text);
    if (match === null) {
      const found =
        this.position >= this.text.length
          ? undefined
          : String.fromCodePoint(this.text.codePointAt(this.position) ?? 0);
      return this.fail('badName', this.position, found);
    }
    this.position += match[0].length;
    return match[0];
  }

  /** Moves past `marker`, which has to occur; `code` and `offset` say what is open when it does not. */
  skipUntil(marker: string, offset: number): number {
    const at = this.text.indexOf(marker, this.position);
    if (at === -1) {
      return this.fail('unterminated', offset);
    }
    this.position = at + marker.length;
    return at;
  }

  /** Fails because a tag that started at `tagStart` does not end where it should. */
  expectTagEnd(tagStart: number): never {
    if (this.position >= this.text.length) {
      return this.fail('unterminated', tagStart);
    }
    return this.fail('badAttribute', this.position, this.text.charAt(this.position));
  }

  /** `<!DOCTYPE ...>` without an internal subset is skipped; with one it is refused. */
  doctype(): void {
    const start = this.position;
    let quote = '';
    for (let index = start + 9; index < this.text.length; index += 1) {
      const char = this.text.charAt(index);
      if (quote !== '') {
        if (char === quote) {
          quote = '';
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '[') {
        this.fail('dtd', start);
      } else if (char === '>') {
        this.position = index + 1;
        return;
      }
    }
    this.fail('unterminated', start);
  }

  attributes(): [string, string][] {
    const attributes: [string, string][] = [];
    const names = new Set<string>();
    for (;;) {
      const before = this.position;
      this.skipSpace();
      const char = this.text.charAt(this.position);
      if (char === '>' || char === '/' || char === '') {
        return attributes;
      }
      if (this.position === before) {
        // Attributes are separated by white space: `<a b="1"c="2">` is not well-formed.
        return this.fail('badAttribute', this.position, char);
      }
      const nameStart = this.position;
      const name = this.name();
      this.skipSpace();
      if (this.text.charAt(this.position) !== '=') {
        return this.fail('badAttribute', nameStart, name);
      }
      this.position += 1;
      this.skipSpace();
      const quote = this.text.charAt(this.position);
      if (quote !== '"' && quote !== "'") {
        return this.fail('badAttribute', nameStart, name);
      }
      const close = this.text.indexOf(quote, this.position + 1);
      if (close === -1) {
        return this.fail('unterminated', this.position);
      }
      const raw = this.text.slice(this.position + 1, close);
      const lt = raw.indexOf('<');
      if (lt !== -1) {
        return this.fail('badAttribute', this.position + 1 + lt, '<');
      }
      if (names.has(name)) {
        return this.fail('duplicateAttribute', nameStart, name);
      }
      names.add(name);
      // White space characters in a value become spaces; line ends are normalised first.
      const value = decode(raw.replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' '), this.position + 1);
      attributes.push([name, value]);
      this.position = close + 1;
    }
  }

  read(): XmlObject {
    const { text } = this;
    const stack: Frame[] = [];
    let root: [string, XmlValue] | undefined;
    if (text.startsWith('\ufeff')) {
      this.position = 1;
    }
    for (;;) {
      const lt = text.indexOf('<', this.position);
      const chunkEnd = lt === -1 ? text.length : lt;
      if (chunkEnd > this.position) {
        const raw = text.slice(this.position, chunkEnd);
        const open = stack[stack.length - 1];
        if (open === undefined) {
          const blank = raw.search(/[^ \t\r\n]/);
          if (blank !== -1) {
            this.fail('textOutsideRoot', this.position + blank);
          }
        } else {
          // Line ends are one `\n` in the content; `]]>` may not appear in text.
          const cdataEnd = raw.indexOf(']]>');
          if (cdataEnd !== -1) {
            this.fail('badCharacter', this.position + cdataEnd, ']]>');
          }
          open.text.push(decode(raw.replace(/\r\n?/g, '\n'), this.position));
        }
        this.position = chunkEnd;
      }
      if (lt === -1) {
        break;
      }
      if (text.startsWith('<!--', lt)) {
        this.position = lt + 4;
        const end = this.skipUntil('-->', lt);
        if (text.slice(lt + 4, end).includes('--')) {
          this.fail('badCharacter', lt + 4 + text.slice(lt + 4, end).indexOf('--'), '--');
        }
      } else if (text.startsWith('<![CDATA[', lt)) {
        const open = stack[stack.length - 1];
        if (open === undefined) {
          this.fail('textOutsideRoot', lt);
        }
        this.position = lt + 9;
        const end = this.skipUntil(']]>', lt);
        open.text.push(text.slice(lt + 9, end).replace(/\r\n?/g, '\n'));
      } else if (text.startsWith('<?', lt)) {
        this.position = lt + 2;
        this.skipUntil('?>', lt);
      } else if (text.startsWith('<!DOCTYPE', lt)) {
        if (root !== undefined || stack.length > 0) {
          this.fail('badName', lt + 2, 'DOCTYPE');
        }
        this.position = lt;
        this.doctype();
      } else if (text.startsWith('</', lt)) {
        this.position = lt + 2;
        const open = stack.pop();
        const nameStart = this.position;
        const name = this.name();
        this.skipSpace();
        if (this.text.charAt(this.position) !== '>') {
          this.expectTagEnd(lt);
        }
        this.position += 1;
        if (open === undefined) {
          this.fail('mismatchedTag', nameStart, name);
        }
        if (open.name !== name) {
          this.fail('mismatchedTag', nameStart, name, open.name);
        }
        const value = finish(open);
        const parent = stack[stack.length - 1];
        if (parent === undefined) {
          root = [open.name, value];
        } else {
          parent.children.push([open.name, value]);
        }
      } else if (text.startsWith('<!', lt)) {
        this.fail('badName', lt + 2, text.slice(lt + 2, lt + 10).split(/[ >]/)[0]);
      } else {
        this.position = lt + 1;
        if (stack.length === 0 && root !== undefined) {
          this.fail('multipleRoots', lt);
        }
        if (stack.length >= MAX_XML_DEPTH) {
          this.fail('tooDeep', lt);
        }
        const name = this.name();
        const attributes = this.attributes();
        const frame: Frame = { name, attributes, children: [], text: [] };
        const selfClosing = this.text.charAt(this.position) === '/';
        if (selfClosing) {
          this.position += 1;
        }
        if (this.text.charAt(this.position) !== '>') {
          this.expectTagEnd(lt);
        }
        this.position += 1;
        if (selfClosing) {
          const value = finish(frame);
          const parent = stack[stack.length - 1];
          if (parent === undefined) {
            root = [name, value];
          } else {
            parent.children.push([name, value]);
          }
        } else {
          stack.push(frame);
        }
      }
    }
    const unclosed = stack[stack.length - 1];
    if (unclosed !== undefined) {
      this.fail('unexpectedEnd', text.length, unclosed.name);
    }
    if (root === undefined) {
      this.fail('noRoot', text.length);
    }
    const result: Record<string, XmlValue> = {};
    setOwn(result, root[0], root[1]);
    return result;
  }
}

/** Reads an XML document into `{ rootName: value }`. Never throws. */
export function parseXml(text: string): XmlParse {
  try {
    if (text.trim() === '') {
      throw new Failure('empty', text.length);
    }
    const bad = badCharacterAt(text);
    if (bad !== -1) {
      throw new Failure('badCharacter', bad, String.fromCodePoint(text.codePointAt(bad) ?? 0));
    }
    return { ok: true, value: new Reader(text).read() };
  } catch (error: unknown) {
    if (!(error instanceof Failure)) {
      throw error;
    }
    const { line, column } = lineColumn(text, error.offset);
    return {
      ok: false,
      error: {
        code: error.code,
        offset: error.offset,
        line,
        column,
        ...(error.found === undefined ? {} : { found: error.found }),
        ...(error.expected === undefined ? {} : { expected: error.expected }),
      },
    };
  }
}

// -- writing -------------------------------------------------------------------------------

export type XmlWriteErrorCode =
  'badName' | 'badCharacter' | 'attributeValue' | 'nestedArray' | 'tooDeep' | 'notFinite';

/** Why a value cannot become XML, with the path of the value in the document. */
export interface XmlWriteError {
  readonly code: XmlWriteErrorCode;
  /** `$.a.b[0]`-style path of the value (the key for a bad name). */
  readonly path: string;
  readonly found?: string;
}

export type XmlWrite =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: XmlWriteError };

/** What the writer takes: the plain values of JSON (and of YAML without dates and binary). */
export type XmlSource =
  null | boolean | number | string | readonly XmlSource[] | { readonly [key: string]: XmlSource };

export interface XmlWriteOptions {
  /** Spaces per level, `'tab'`, or 0 for no white space between elements. */
  readonly indent: number | 'tab';
  /** The name of the element around a document that has no single root of its own. */
  readonly rootName: string;
  /** Write `<?xml version="1.0" encoding="UTF-8"?>` first. */
  readonly declaration: boolean;
}

class WriteFailure extends Error {
  constructor(readonly detail: XmlWriteError) {
    super(detail.code);
  }
}

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;',
  );
}

function escapeAttribute(text: string): string {
  return text.replace(/[&<>"\t\n\r]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\t':
        return '&#9;';
      case '\n':
        return '&#10;';
      default:
        return '&#13;';
    }
  });
}

function pathText(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (result, part) =>
      typeof part === 'number'
        ? `${result}[${String(part)}]`
        : /^[A-Za-z_$][\w$]*$/.test(part)
          ? `${result}.${part}`
          : `${result}[${JSON.stringify(part)}]`,
    '$',
  );
}

type Scalar = null | boolean | number | string;
type Path = readonly (string | number)[];

function isScalar(value: XmlSource): value is Scalar {
  return value === null || typeof value !== 'object';
}

function isList(value: XmlSource): value is readonly XmlSource[] {
  return Array.isArray(value);
}

/**
 * The document as `{ name, content }`: a single key that holds no array is the root as it is,
 * anything else (several keys, an array, a plain value) goes inside `rootName`.
 */
function rootOf(
  value: XmlSource,
  rootName: string,
): { name: string; content: XmlSource; path: Path } {
  if (isScalar(value)) {
    return { name: rootName, content: value, path: [] };
  }
  if (isList(value)) {
    return { name: rootName, content: { item: value }, path: [] };
  }
  const entries = Object.entries(value);
  const [only] = entries;
  if (
    entries.length === 1 &&
    only !== undefined &&
    !only[0].startsWith(ATTRIBUTE_PREFIX) &&
    only[0] !== TEXT_KEY &&
    !isList(only[1])
  ) {
    return { name: only[0], content: only[1], path: [only[0]] };
  }
  return { name: rootName, content: value, path: [] };
}

/** Writes a value as an XML document. Never throws. */
export function writeXml(value: XmlSource, options: XmlWriteOptions): XmlWrite {
  const unit = options.indent === 'tab' ? '\t' : ' '.repeat(options.indent);
  const compact = options.indent === 0;
  const lines: string[] = [];

  const fail = (code: XmlWriteErrorCode, path: Path, found?: string): never => {
    throw new WriteFailure({
      code,
      path: pathText(path),
      ...(found === undefined ? {} : { found }),
    });
  };

  /** Names already found valid: a list of a million items under one key checks that key once. */
  const goodNames = new Set<string>();
  const requireName = (name: string, path: Path): void => {
    if (goodNames.has(name)) {
      return;
    }
    if (isXmlName(name)) {
      goodNames.add(name);
    } else {
      fail('badName', path, name);
    }
  };

  const text = (scalar: Scalar, path: Path): string => {
    if (scalar === null) {
      return '';
    }
    if (typeof scalar === 'number' && !Number.isFinite(scalar)) {
      return fail('notFinite', path, String(scalar));
    }
    const written = String(scalar);
    const bad = badCharacterAt(written);
    if (bad !== -1) {
      const code = (written.codePointAt(bad) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      return fail('badCharacter', path, `U+${code}`);
    }
    return written;
  };

  /** One element for `content`; `path` is where the value sits in the document. */
  const element = (name: string, content: XmlSource, path: Path, level: number): void => {
    if (level > MAX_XML_DEPTH) {
      fail('tooDeep', path);
    }
    requireName(name, path);
    const pad = unit.repeat(level);
    if (isList(content)) {
      fail('nestedArray', path);
      return;
    }
    if (isScalar(content)) {
      const body = text(content, path);
      lines.push(body === '' ? `${pad}<${name}/>` : `${pad}<${name}>${escapeText(body)}</${name}>`);
      return;
    }
    let attributes = '';
    let own = '';
    const children: [string, XmlSource][] = [];
    for (const [key, entry] of Object.entries(content)) {
      const here = [...path, key];
      if (key === TEXT_KEY || key.startsWith(ATTRIBUTE_PREFIX)) {
        if (!isScalar(entry)) {
          fail('attributeValue', here);
          return;
        }
        if (key === TEXT_KEY) {
          own = text(entry, here);
        } else {
          const attribute = key.slice(ATTRIBUTE_PREFIX.length);
          requireName(attribute, here);
          attributes += ` ${attribute}="${escapeAttribute(text(entry, here))}"`;
        }
      } else {
        children.push([key, entry]);
      }
    }
    if (children.length === 0) {
      lines.push(
        own === ''
          ? `${pad}<${name}${attributes}/>`
          : `${pad}<${name}${attributes}>${escapeText(own)}</${name}>`,
      );
      return;
    }
    lines.push(`${pad}<${name}${attributes}>`);
    if (own !== '') {
      lines.push(`${unit.repeat(level + 1)}${escapeText(own)}`);
    }
    for (const [key, entry] of children) {
      const here = [...path, key];
      if (isList(entry)) {
        entry.forEach((item, index) => {
          element(key, item, [...here, index], level + 1);
        });
      } else {
        element(key, entry, here, level + 1);
      }
    }
    lines.push(`${pad}</${name}>`);
  };

  try {
    const root = rootOf(value, options.rootName);
    element(root.name, root.content, root.path, 0);
    const header = options.declaration ? '<?xml version="1.0" encoding="UTF-8"?>' : '';
    const body = lines.join(compact ? '' : '\n');
    return { ok: true, text: header === '' ? body : `${header}${compact ? '' : '\n'}${body}` };
  } catch (error: unknown) {
    if (error instanceof WriteFailure) {
      return { ok: false, error: error.detail };
    }
    throw error;
  }
}
