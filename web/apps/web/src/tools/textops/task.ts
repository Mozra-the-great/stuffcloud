import type { TaskContext } from '@stuffcloud/tools';
import { CASE_STYLES, convertCase, type CaseStyle } from './case.ts';
import { countText, type Counts } from './count.ts';
import {
  MAX_SEPARATOR_LENGTH,
  MAX_START,
  dedupeLines,
  numberLines,
  sortLines,
  trimLines,
  type TrimMode,
} from './lines.ts';
import { MAX_FIND_LENGTH, replaceText, type ReplaceError } from './replace.ts';
import { slugify, type SlugSeparator } from './slug.ts';

/**
 * The work of the tool: one operation on the text, and the counters of the text. It runs in a worker
 * (a large text, or a pattern that backtracks a lot, must not freeze the page) that the page stops on
 * a timeout, so it must not touch the DOM.
 */

export type Operation = 'case' | 'sort' | 'dedupe' | 'trim' | 'number' | 'replace' | 'slug';

export const OPERATIONS: readonly Operation[] = [
  'case',
  'sort',
  'dedupe',
  'trim',
  'number',
  'replace',
  'slug',
];

export type Request =
  | { readonly operation: 'case'; readonly style: CaseStyle }
  | {
      readonly operation: 'sort';
      readonly descending: boolean;
      readonly ignoreCase: boolean;
      readonly numeric: boolean;
      readonly locale: string;
    }
  | {
      readonly operation: 'dedupe';
      readonly ignoreCase: boolean;
      readonly ignoreWhitespace: boolean;
    }
  | {
      readonly operation: 'trim';
      readonly mode: TrimMode;
      readonly removeEmptyLines: boolean;
      readonly collapse: boolean;
    }
  | {
      readonly operation: 'number';
      readonly start: number;
      readonly separator: string;
      readonly pad: boolean;
    }
  | {
      readonly operation: 'replace';
      readonly find: string;
      readonly replacement: string;
      readonly regex: boolean;
      readonly ignoreCase: boolean;
      readonly wholeWord: boolean;
    }
  | {
      readonly operation: 'slug';
      readonly separator: SlugSeparator;
      readonly asciiOnly: boolean;
      readonly germanUmlauts: boolean;
    };

export interface Input {
  readonly text: string;
  /** What to do with the text; `null` only counts it (the options on the page are not complete). */
  readonly request: Request | null;
}

export type OperationError = ReplaceError;

export type Result =
  | {
      readonly ok: true;
      readonly text: string;
      /** What the operation counted, if it counted something: `replaced` matches, `removed` lines. */
      readonly detail?: { readonly kind: 'replaced' | 'removed'; readonly count: number };
    }
  | { readonly ok: false; readonly error: OperationError };

export interface Output {
  /** `null` when there was no request. */
  readonly result: Result | null;
  /** The counters of the input text. */
  readonly counts: Counts;
}

/** Longest text; the counters and the operations stay fast and the page stays responsive. */
export const MAX_TEXT_LENGTH = 2_000_000;
/** The page stops the worker after this long. */
export const TASK_TIMEOUT_MS = 5000;
export { MAX_FIND_LENGTH, MAX_SEPARATOR_LENGTH, MAX_START };

const TRIM_MODES: readonly string[] = ['both', 'start', 'end'];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)) {
    return false;
  }
  switch (value['operation']) {
    case 'case':
      return (
        typeof value['style'] === 'string' && CASE_STYLES.includes(value['style'] as CaseStyle)
      );
    case 'sort':
      return (
        typeof value['descending'] === 'boolean' &&
        typeof value['ignoreCase'] === 'boolean' &&
        typeof value['numeric'] === 'boolean' &&
        typeof value['locale'] === 'string'
      );
    case 'dedupe':
      return (
        typeof value['ignoreCase'] === 'boolean' && typeof value['ignoreWhitespace'] === 'boolean'
      );
    case 'trim':
      return (
        typeof value['mode'] === 'string' &&
        TRIM_MODES.includes(value['mode']) &&
        typeof value['removeEmptyLines'] === 'boolean' &&
        typeof value['collapse'] === 'boolean'
      );
    case 'number':
      return (
        typeof value['start'] === 'number' &&
        Number.isSafeInteger(value['start']) &&
        typeof value['separator'] === 'string' &&
        typeof value['pad'] === 'boolean'
      );
    case 'replace':
      return (
        typeof value['find'] === 'string' &&
        typeof value['replacement'] === 'string' &&
        typeof value['regex'] === 'boolean' &&
        typeof value['ignoreCase'] === 'boolean' &&
        typeof value['wholeWord'] === 'boolean'
      );
    case 'slug':
      return (
        (value['separator'] === '-' || value['separator'] === '_') &&
        typeof value['asciiOnly'] === 'boolean' &&
        typeof value['germanUmlauts'] === 'boolean'
      );
    default:
      return false;
  }
}

export function isInput(value: unknown): value is Input {
  return (
    isRecord(value) &&
    typeof value['text'] === 'string' &&
    (value['request'] === null || isRequest(value['request']))
  );
}

function apply(text: string, request: Request): Result {
  switch (request.operation) {
    case 'case':
      return { ok: true, text: convertCase(text, request.style) };
    case 'sort':
      return { ok: true, text: sortLines(text, request) };
    case 'dedupe': {
      const { text: deduped, removed } = dedupeLines(text, request);
      return { ok: true, text: deduped, detail: { kind: 'removed', count: removed } };
    }
    case 'trim':
      return { ok: true, text: trimLines(text, request) };
    case 'number':
      return { ok: true, text: numberLines(text, request) };
    case 'replace': {
      const replaced = replaceText(text, request);
      return replaced.ok
        ? { ok: true, text: replaced.text, detail: { kind: 'replaced', count: replaced.count } }
        : replaced;
    }
    case 'slug':
      return { ok: true, text: slugify(text, request) };
  }
}

export function runTask(input: Input, { progress }: TaskContext): Output {
  progress(0, 1);
  const output: Output = {
    result: input.request === null ? null : apply(input.text, input.request),
    counts: countText(input.text),
  };
  progress(1, 1);
  return output;
}
