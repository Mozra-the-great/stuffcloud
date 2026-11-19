import { parseDocument, stringify as stringifyYaml } from 'yaml';
import {
  MAX_DEPTH,
  formatJson,
  locate,
  parseJson,
  statsOf,
  toValue,
  type JsonNode,
  type JsonValue,
} from '../json-formatter/json.ts';
import { parseXml, setOwn, writeXml, type XmlValue } from './xml.ts';

/**
 * The conversion between JSON, YAML and XML, as a pure function. The page runs it in a worker
 * (a document can be large, and a hostile one is stopped by terminating the worker on a timeout),
 * so it must not touch the DOM.
 *
 * Every limit below keeps a document from growing in memory out of proportion to its size: YAML
 * aliases and XML entities are the classic ways to do that ("billion laughs"). XML entities are not
 * supported at all (see `xml.ts`); the YAML reader refuses more than 100 aliases; and whatever
 * is read is counted, with every use of a shared value counted again, before it is written.
 */

export const FORMATS = ['json', 'yaml', 'xml'] as const;
export type Format = (typeof FORMATS)[number];

export function isFormat(value: unknown): value is Format {
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value);
}

/** Longest input accepted, in characters. */
export const MAX_INPUT_CHARS = 5_000_000;
/** Most values a document may hold once every alias is expanded. */
export const MAX_NODES = 2_000_000;
/** Most characters of all strings of a document together, once every alias is expanded. */
export const MAX_TOTAL_CHARS = 40_000_000;
/** The most characters a result may have; what the result will take is estimated before it is written. */
export const MAX_OUTPUT_CHARS = 100_000_000;
/** Most times a YAML document may use its aliases (a bomb uses them without end). */
export const ALIAS_LIMIT = 50;
/** The longest element name offered for the root. */
export const MAX_ROOT_NAME_LENGTH = 100;

export interface Input {
  readonly from: Format;
  readonly to: Format;
  readonly text: string;
  /** Spaces per level, `'tab'`, or 0 for the shortest form (JSON and XML; YAML has no such form). */
  readonly indent: number | 'tab';
  readonly sortKeys: boolean;
  /** XML only: the element around a document that has no single root of its own. */
  readonly rootName: string;
  /** XML to JSON or YAML: turn text that is exactly a number, `true` or `false` into that value. */
  readonly typed: boolean;
  /** To XML: write the `<?xml ...?>` line. */
  readonly declaration: boolean;
}

export function isInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const indent = record['indent'];
  return (
    isFormat(record['from']) &&
    isFormat(record['to']) &&
    typeof record['text'] === 'string' &&
    (indent === 'tab' || indent === 0 || indent === 2 || indent === 4) &&
    typeof record['sortKeys'] === 'boolean' &&
    typeof record['rootName'] === 'string' &&
    typeof record['typed'] === 'boolean' &&
    typeof record['declaration'] === 'boolean'
  );
}

/** What went wrong, in terms the page words in either language. */
export interface ConvertError {
  /** `read`: the input is not valid; `write`: the value cannot be written in the target format. */
  readonly where: 'read' | 'write' | 'limit';
  /** The format that was being read or written. */
  readonly format: Format;
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  readonly found?: string;
  readonly expected?: string;
  /** Where in the document, as `$.a.b[0]`. */
  readonly path?: string;
  /** The reader's own message (YAML), English only. */
  readonly detail?: string;
  readonly max?: number;
}

/** Something to tell the visitor about a result that is fine. */
export interface Note {
  readonly kind: 'bigNumbers' | 'nulls';
  readonly count: number;
}

export type Output =
  | { readonly ok: true; readonly text: string; readonly notes: readonly Note[] }
  | { readonly ok: false; readonly error: ConvertError };

/** What a read gives: the value, and what it lost on the way. */
interface Read {
  readonly value: unknown;
  /** The document as read, when it is JSON (so a JSON to JSON run keeps every digit). */
  readonly node?: JsonNode;
  readonly notes: readonly Note[];
}

class Problem extends Error {
  constructor(readonly error: ConvertError) {
    super(error.code);
  }
}

function problem(error: ConvertError): never {
  throw new Problem(error);
}

// -- reading -------------------------------------------------------------------------------

function readJson(text: string): Read {
  const result = parseJson(text, { strict: false });
  if (!result.ok) {
    const { error } = result;
    return problem({
      where: 'read',
      format: 'json',
      code: error.code,
      line: error.line,
      column: error.column,
      ...(error.found === undefined ? {} : { found: error.found }),
      ...(error.expected === undefined ? {} : { expected: error.expected }),
      ...(error.code === 'tooDeep' ? { max: MAX_DEPTH } : {}),
    });
  }
  const { bigNumbers } = statsOf(result.node);
  return {
    value: toValue(result.node),
    node: result.node,
    notes: bigNumbers > 0 ? [{ kind: 'bigNumbers', count: bigNumbers }] : [],
  };
}

function readYaml(text: string): Read {
  try {
    const document = parseDocument(text, {
      prettyErrors: false,
      uniqueKeys: true,
      // Always YAML 1.2 core: a `%YAML 1.1` line would switch on merge keys, which copy.
      schema: 'core',
      version: '1.2',
    });
    const [first] = document.errors;
    if (first !== undefined) {
      const { line, column } = locate(text, first.pos[0]);
      return problem({
        where: 'read',
        format: 'yaml',
        // The reader's own limit on nesting is the same limit as ours, in its words.
        code: first.code === 'RESOURCE_EXHAUSTION' ? 'tooDeep' : first.code,
        ...(first.code === 'RESOURCE_EXHAUSTION' ? { max: MAX_DEPTH } : {}),
        line,
        column,
        detail: first.message,
      });
    }
    return { value: document.toJS({ maxAliasCount: ALIAS_LIMIT }) as unknown, notes: [] };
  } catch (error: unknown) {
    if (error instanceof Problem) {
      throw error;
    }
    if (error instanceof ReferenceError) {
      // The alias limit of the reader: "Excessive alias count indicates a resource exhaustion attack".
      return problem({ where: 'read', format: 'yaml', code: 'aliasLimit', max: ALIAS_LIMIT });
    }
    throw error;
  }
}

const CANONICAL_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Text that is exactly a number or a boolean as JSON writes it becomes that value. */
function typify(value: XmlValue): unknown {
  if (typeof value === 'string') {
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
    if (CANONICAL_NUMBER.test(value)) {
      const number = Number(value);
      if (Number.isFinite(number) && String(number) === value) {
        return number;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return (value as readonly XmlValue[]).map(typify);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Readonly<Record<string, XmlValue>>)) {
    setOwn(result, key, typify(entry));
  }
  return result;
}

function readXml(text: string, typed: boolean): Read {
  const result = parseXml(text);
  if (!result.ok) {
    const { error } = result;
    return problem({
      where: 'read',
      format: 'xml',
      code: error.code,
      line: error.line,
      column: error.column,
      ...(error.found === undefined ? {} : { found: error.found }),
      ...(error.expected === undefined ? {} : { expected: error.expected }),
    });
  }
  return { value: typed ? typify(result.value) : result.value, notes: [] };
}

// -- checking ------------------------------------------------------------------------------

interface Trail {
  readonly parent: Trail | undefined;
  readonly key: string | number;
}

function pathOf(trail: Trail | undefined): string {
  const keys: (string | number)[] = [];
  for (let step = trail; step !== undefined; step = step.parent) {
    keys.push(step.key);
  }
  return keys
    .reverse()
    .reduce<string>(
      (path, key) =>
        typeof key === 'number'
          ? `${path}[${String(key)}]`
          : /^[A-Za-z_$][\w$]*$/.test(key)
            ? `${path}.${key}`
            : `${path}[${JSON.stringify(key)}]`,
      '$',
    );
}

export interface Checked {
  /** Values that are `null` (XML writes them as empty elements). */
  readonly nulls: number;
  /** Every use of every value, shared values counted each time. */
  readonly nodes: number;
  /** The depth of every value added up: what indentation will cost per level of it. */
  readonly depthSum: number;
  /** The characters of all strings and keys, shared ones counted each time. */
  readonly characters: number;
}

/**
 * Walks a value without recursion, counting every use of every value (a value that YAML aliases
 * share is counted each time it is used), and checks that it holds only what JSON can hold.
 * Fails when it is too large, nested too deeply or not plain data; `finite` also refuses `NaN`
 * and the infinities (JSON and XML have no way to write them).
 */
export function checkData(root: unknown, finite: boolean): Checked {
  let nodes = 0;
  let characters = 0;
  let nulls = 0;
  let depthSum = 0;
  const stack: { value: unknown; depth: number; trail: Trail | undefined }[] = [
    { value: root, depth: 1, trail: undefined },
  ];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) {
      return { nulls, nodes, depthSum, characters };
    }
    const { value, depth, trail } = item;
    nodes += 1;
    depthSum += depth;
    if (nodes > MAX_NODES) {
      problem({ where: 'limit', format: 'json', code: 'tooManyValues', max: MAX_NODES });
    }
    if (depth > MAX_DEPTH) {
      problem({ where: 'limit', format: 'json', code: 'tooDeep', max: MAX_DEPTH });
    }
    if (value === null) {
      nulls += 1;
    } else if (typeof value === 'string') {
      characters += value.length;
      if (characters > MAX_TOTAL_CHARS) {
        problem({ where: 'limit', format: 'json', code: 'tooLarge', max: MAX_TOTAL_CHARS });
      }
    } else if (typeof value === 'number') {
      if (finite && !Number.isFinite(value)) {
        problem({
          where: 'write',
          format: 'json',
          code: 'notFinite',
          found: String(value),
          path: pathOf(trail),
        });
      }
    } else if (typeof value === 'boolean') {
      continue;
    } else if (Array.isArray(value)) {
      const items = value as readonly unknown[];
      // XML writes the key of a list again for every item, as the open and the close tag.
      if (typeof trail?.key === 'string') {
        characters += trail.key.length * items.length;
      }
      items.forEach((entry, index) => {
        stack.push({ value: entry, depth: depth + 1, trail: { parent: trail, key: index } });
      });
    } else if (
      typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
    ) {
      for (const [key, entry] of Object.entries(value)) {
        characters += key.length;
        stack.push({ value: entry, depth: depth + 1, trail: { parent: trail, key } });
      }
    } else {
      problem({
        where: 'write',
        format: 'json',
        code: 'notData',
        found: typeof value === 'object' ? 'object' : typeof value,
        path: pathOf(trail),
      });
    }
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map(sorted);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : 1));
    for (const key of keys) {
      setOwn(result, key, sorted((value as Readonly<Record<string, unknown>>)[key]));
    }
    return result;
  }
  return value;
}

/**
 * What the result will take at most, in characters: every value a line of its own with its
 * indentation, and every character of a string at the longest escape any of the formats writes.
 * Indentation is what makes a deeply nested document of modest size a huge text.
 */
export function outputEstimate(checked: Checked, indent: Input['indent']): number {
  const width = indent === 'tab' ? 1 : indent;
  return checked.nodes * 8 + checked.depthSum * width + checked.characters * 6;
}

// -- writing -------------------------------------------------------------------------------

function writeJson(value: unknown, input: Input): string {
  const space = input.indent === 'tab' ? '\t' : input.indent;
  return JSON.stringify(input.sortKeys ? sorted(value) : value, null, space);
}

function writeYaml(value: unknown, input: Input): string {
  return stringifyYaml(value, {
    indent: input.indent === 4 ? 4 : 2,
    sortMapEntries: input.sortKeys,
    lineWidth: 0,
    aliasDuplicateObjects: false,
  });
}

function writeXmlText(value: unknown, input: Input): string {
  const result = writeXml((input.sortKeys ? sorted(value) : value) as JsonValue, {
    indent: input.indent,
    rootName: input.rootName,
    declaration: input.declaration,
  });
  if (!result.ok) {
    const { error } = result;
    return problem({
      where: 'write',
      format: 'xml',
      code: error.code,
      path: error.path,
      ...(error.found === undefined ? {} : { found: error.found }),
    });
  }
  return result.text;
}

/** Converts `input.text` from one format to another. Never throws for a document that is wrong. */
export function convert(input: Input): Output {
  try {
    if (input.text.length > MAX_INPUT_CHARS) {
      problem({ where: 'limit', format: input.from, code: 'inputTooLarge', max: MAX_INPUT_CHARS });
    }
    if (input.text.trim() === '') {
      problem({ where: 'read', format: input.from, code: 'empty' });
    }
    const read =
      input.from === 'json'
        ? readJson(input.text)
        : input.from === 'yaml'
          ? readYaml(input.text)
          : readXml(input.text, input.typed);
    // JSON and XML cannot write NaN or an infinity; a JSON number too large for a JavaScript number is
    // one, and YAML would have to change it into `.inf`. JSON to JSON keeps the digits as they are.
    const finite =
      input.to === 'xml' ||
      (input.to === 'json' && input.from !== 'json') ||
      (input.to === 'yaml' && input.from === 'json');
    const checked = checkData(read.value, finite);
    const notes: Note[] = input.from === 'json' ? [...read.notes] : [];
    if (input.to === 'xml' && checked.nulls > 0) {
      notes.push({ kind: 'nulls', count: checked.nulls });
    }
    if (outputEstimate(checked, input.indent) > MAX_OUTPUT_CHARS) {
      problem({ where: 'limit', format: input.to, code: 'tooLarge', max: MAX_OUTPUT_CHARS });
    }
    if (input.from === 'json' && input.to === 'json' && read.node !== undefined) {
      return {
        ok: true,
        text: formatJson(read.node, {
          indent: input.indent === 'tab' ? 'tab' : input.indent,
          sortKeys: input.sortKeys,
        }),
        notes: notes.filter((note) => note.kind !== 'bigNumbers'),
      };
    }
    // YAML and XML numbers are plain values here: only JSON text can carry a digit too many.
    const text =
      input.to === 'json'
        ? writeJson(read.value, input)
        : input.to === 'yaml'
          ? writeYaml(read.value, input)
          : writeXmlText(read.value, input);
    return { ok: true, text, notes };
  } catch (error: unknown) {
    if (error instanceof Problem) {
      return { ok: false, error: error.error };
    }
    throw error;
  }
}

/** The work of the tool. It runs in the worker, so it must not touch the DOM. */
export function runTask(
  input: Input,
  context: { progress: (done: number, total: number) => void },
): Output {
  const output = convert(input);
  context.progress(1, 1);
  return output;
}
