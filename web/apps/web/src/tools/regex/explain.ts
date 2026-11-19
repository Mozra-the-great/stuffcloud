/**
 * Explains a regular expression part by part. The explanation is a flat list of items with a depth (a
 * group's contents are one level deeper), so the page can show it as an indented list. Only patterns the
 * browser accepts are explained, but the reader never throws: a construct it does not know is shown as
 * the literal text it looks like.
 */

export type ExplainKey =
  | 'literal'
  | 'any'
  | 'anyAll'
  | 'digit'
  | 'notDigit'
  | 'word'
  | 'notWord'
  | 'space'
  | 'notSpace'
  | 'wordBoundary'
  | 'notWordBoundary'
  | 'start'
  | 'startLine'
  | 'end'
  | 'endLine'
  | 'lineFeed'
  | 'carriageReturn'
  | 'tab'
  | 'verticalTab'
  | 'formFeed'
  | 'nul'
  | 'backspace'
  | 'codePoint'
  | 'control'
  | 'property'
  | 'notProperty'
  | 'backReference'
  | 'namedBackReference'
  | 'classStart'
  | 'classStartNot'
  | 'classRange'
  | 'classEmpty'
  | 'classAny'
  | 'classSet'
  | 'group'
  | 'groupNamed'
  | 'groupPlain'
  | 'lookahead'
  | 'notLookahead'
  | 'lookbehind'
  | 'notLookbehind'
  | 'modifiers'
  | 'alternation'
  | 'optional'
  | 'zeroOrMore'
  | 'oneOrMore'
  | 'exactly'
  | 'atLeast'
  | 'between';

export type ExplainParams = Readonly<Record<string, string | number>>;

export interface ExplainItem {
  /** How deep inside groups and character sets the part is. */
  readonly depth: number;
  /** The part as written in the pattern. */
  readonly source: string;
  readonly key: ExplainKey;
  readonly params: ExplainParams;
  /** A repetition that takes as few as possible instead of as many. */
  readonly lazy: boolean;
}

interface Piece {
  readonly key: ExplainKey;
  readonly params: ExplainParams;
}

interface Atom {
  /** The literal character, when the atom is one. */
  readonly char: string | undefined;
  readonly piece: Piece | undefined;
  readonly source: string;
  /** The index after the atom. */
  readonly next: number;
}

interface Literal {
  readonly text: string;
  readonly source: string;
}

const HEX = /^[0-9a-fA-F]+$/;
const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

const CLASS_ESCAPES: Readonly<Record<string, ExplainKey>> = {
  d: 'digit',
  D: 'notDigit',
  w: 'word',
  W: 'notWord',
  s: 'space',
  S: 'notSpace',
};

const CONTROL_ESCAPES: Readonly<Record<string, ExplainKey>> = {
  n: 'lineFeed',
  r: 'carriageReturn',
  t: 'tab',
  v: 'verticalTab',
  f: 'formFeed',
};

function codePointPiece(code: number): Piece {
  return { key: 'codePoint', params: { code: code.toString(16).toUpperCase().padStart(4, '0') } };
}

/** Reads the escape that starts at `chars[start]` (a backslash). */
function readEscape(
  chars: readonly string[],
  start: number,
  inClass: boolean,
  unicode: boolean,
): Atom {
  const next = chars[start + 1];
  const source = (end: number): string => chars.slice(start, end).join('');
  if (next === undefined) {
    return { char: '\\', piece: undefined, source: '\\', next: start + 1 };
  }
  const classKey = CLASS_ESCAPES[next];
  if (classKey !== undefined) {
    return {
      char: undefined,
      piece: { key: classKey, params: {} },
      source: source(start + 2),
      next: start + 2,
    };
  }
  const controlKey = CONTROL_ESCAPES[next];
  if (controlKey !== undefined) {
    return {
      char: undefined,
      piece: { key: controlKey, params: {} },
      source: source(start + 2),
      next: start + 2,
    };
  }
  if (next === 'b') {
    const key: ExplainKey = inClass ? 'backspace' : 'wordBoundary';
    return {
      char: undefined,
      piece: { key, params: {} },
      source: source(start + 2),
      next: start + 2,
    };
  }
  if (next === 'B' && !inClass) {
    return {
      char: undefined,
      piece: { key: 'notWordBoundary', params: {} },
      source: source(start + 2),
      next: start + 2,
    };
  }
  if (next === '0' && !/\d/.test(chars[start + 2] ?? '')) {
    return {
      char: undefined,
      piece: { key: 'nul', params: {} },
      source: source(start + 2),
      next: start + 2,
    };
  }
  if (/[1-9]/.test(next) && !inClass) {
    let end = start + 2;
    while (/\d/.test(chars[end] ?? '')) {
      end += 1;
    }
    const number = Number(chars.slice(start + 1, end).join(''));
    return {
      char: undefined,
      piece: { key: 'backReference', params: { n: number } },
      source: source(end),
      next: end,
    };
  }
  if (next === 'x') {
    const digits = chars.slice(start + 2, start + 4).join('');
    if (digits.length === 2 && HEX.test(digits)) {
      return {
        char: undefined,
        piece: codePointPiece(Number.parseInt(digits, 16)),
        source: source(start + 4),
        next: start + 4,
      };
    }
  }
  if (next === 'u') {
    if (chars[start + 2] === '{' && unicode) {
      const close = chars.indexOf('}', start + 3);
      const digits = close < 0 ? '' : chars.slice(start + 3, close).join('');
      if (HEX.test(digits)) {
        return {
          char: undefined,
          piece: codePointPiece(Number.parseInt(digits, 16)),
          source: source(close + 1),
          next: close + 1,
        };
      }
    }
    const digits = chars.slice(start + 2, start + 6).join('');
    if (digits.length === 4 && HEX.test(digits)) {
      return {
        char: undefined,
        piece: codePointPiece(Number.parseInt(digits, 16)),
        source: source(start + 6),
        next: start + 6,
      };
    }
  }
  if (next === 'c' && /[A-Za-z]/.test(chars[start + 2] ?? '')) {
    const letter = (chars[start + 2] ?? '').toUpperCase();
    return {
      char: undefined,
      piece: { key: 'control', params: { letter } },
      source: source(start + 3),
      next: start + 3,
    };
  }
  if ((next === 'p' || next === 'P') && unicode && chars[start + 2] === '{') {
    const close = chars.indexOf('}', start + 3);
    if (close > 0) {
      const property = chars.slice(start + 3, close).join('');
      const key: ExplainKey = next === 'p' ? 'property' : 'notProperty';
      return {
        char: undefined,
        piece: { key, params: { property } },
        source: source(close + 1),
        next: close + 1,
      };
    }
  }
  if (next === 'k' && !inClass && chars[start + 2] === '<') {
    const close = chars.indexOf('>', start + 3);
    if (close > 0) {
      const name = chars.slice(start + 3, close).join('');
      return {
        char: undefined,
        piece: { key: 'namedBackReference', params: { name } },
        source: source(close + 1),
        next: close + 1,
      };
    }
  }
  // Any other escaped character stands for itself (`\.`, `\/`, `\-`).
  return { char: next, piece: undefined, source: source(start + 2), next: start + 2 };
}

/** The end (index of the closing bracket) of the class that starts at `chars[start]`, and whether it is a v-mode set. */
function classEnd(
  chars: readonly string[],
  start: number,
  sets: boolean,
): { end: number; complex: boolean } {
  let depth = 0;
  let complex = false;
  for (let index = start; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '\\') {
      if (sets && chars[index + 1] === 'q') {
        complex = true;
      }
      index += 1;
    } else if (char === '[') {
      depth += 1;
      if (sets && depth > 1) {
        complex = true;
      }
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0 || !sets) {
        return { end: index, complex };
      }
    } else if (sets && (char === '&' || char === '-') && chars[index + 1] === char) {
      complex = true;
    }
  }
  return { end: chars.length, complex };
}

/** Explains `pattern` as the browser reads it with `flags`. */
export function explainPattern(pattern: string, flags: string): ExplainItem[] {
  const chars = Array.from(pattern);
  const unicode = flags.includes('u') || flags.includes('v');
  const sets = flags.includes('v');
  const items: ExplainItem[] = [];
  const literals: Literal[] = [];
  let depth = 0;
  let groups = 0;

  const add = (itemDepth: number, source: string, piece: Piece, lazy = false): void => {
    items.push({ depth: itemDepth, source, key: piece.key, params: piece.params, lazy });
  };

  const flushLiterals = (keep = 0): void => {
    const count = literals.length - keep;
    if (count > 0) {
      const taken = literals.splice(0, count);
      add(depth, taken.map((l) => l.source).join(''), {
        key: 'literal',
        params: { text: taken.map((l) => l.text).join('') },
      });
    }
  };

  const readClass = (start: number): number => {
    const { end, complex } = classEnd(chars, start, sets);
    const source = chars.slice(start, end + 1).join('');
    if (complex) {
      add(depth, source, { key: 'classSet', params: {} });
      return end + 1;
    }
    let index = start + 1;
    const negated = chars[index] === '^';
    if (negated) {
      index += 1;
    }
    if (end === index) {
      add(depth, source, { key: negated ? 'classAny' : 'classEmpty', params: {} });
      return end + 1;
    }
    add(depth, source, { key: negated ? 'classStartNot' : 'classStart', params: {} });
    const readAtom = (at: number): Atom =>
      chars[at] === '\\'
        ? readEscape(chars, at, true, unicode)
        : { char: chars[at], piece: undefined, source: chars[at] ?? '', next: at + 1 };
    while (index < end) {
      const first = readAtom(index);
      if (first.char !== undefined && chars[first.next] === '-' && first.next + 1 < end) {
        const last = readAtom(first.next + 1);
        if (last.char !== undefined) {
          add(depth + 1, `${first.source}-${last.source}`, {
            key: 'classRange',
            params: { from: first.char, to: last.char },
          });
          index = last.next;
          continue;
        }
      }
      add(
        depth + 1,
        first.source,
        first.piece ?? { key: 'literal', params: { text: first.char ?? '' } },
      );
      index = first.next;
    }
    return end + 1;
  };

  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? '';
    if (char === '\\') {
      const atom = readEscape(chars, index, false, unicode);
      if (atom.char !== undefined) {
        literals.push({ text: atom.char, source: atom.source });
      } else if (atom.piece !== undefined) {
        flushLiterals();
        add(depth, atom.source, atom.piece);
      }
      index = atom.next;
    } else if (char === '[') {
      flushLiterals();
      index = readClass(index);
    } else if (char === '(') {
      flushLiterals();
      const rest = chars.slice(index, index + 4).join('');
      let header: { source: string; piece: Piece };
      if (rest.startsWith('(?:')) {
        header = { source: '(?:', piece: { key: 'groupPlain', params: {} } };
      } else if (rest.startsWith('(?=')) {
        header = { source: '(?=', piece: { key: 'lookahead', params: {} } };
      } else if (rest.startsWith('(?!')) {
        header = { source: '(?!', piece: { key: 'notLookahead', params: {} } };
      } else if (rest.startsWith('(?<=')) {
        header = { source: '(?<=', piece: { key: 'lookbehind', params: {} } };
      } else if (rest.startsWith('(?<!')) {
        header = { source: '(?<!', piece: { key: 'notLookbehind', params: {} } };
      } else if (rest.startsWith('(?<')) {
        const close = chars.indexOf('>', index + 3);
        const name = chars.slice(index + 3, close < 0 ? index + 3 : close).join('');
        groups += 1;
        header = {
          source: chars.slice(index, (close < 0 ? index + 2 : close) + 1).join(''),
          piece: { key: 'groupNamed', params: { n: groups, name } },
        };
      } else if (rest.startsWith('(?')) {
        const colon = chars.indexOf(':', index + 2);
        const modifiers = chars.slice(index + 2, colon < 0 ? index + 2 : colon).join('');
        header = {
          source: chars.slice(index, (colon < 0 ? index + 1 : colon) + 1).join(''),
          piece: { key: 'modifiers', params: { modifiers } },
        };
      } else {
        groups += 1;
        header = { source: '(', piece: { key: 'group', params: { n: groups } } };
      }
      add(depth, header.source, header.piece);
      depth += 1;
      index += Array.from(header.source).length;
    } else if (char === ')') {
      flushLiterals();
      depth = Math.max(0, depth - 1);
      index += 1;
    } else if (char === '|') {
      flushLiterals();
      add(depth, '|', { key: 'alternation', params: {} });
      index += 1;
    } else if (char === '.') {
      flushLiterals();
      add(depth, '.', { key: flags.includes('s') ? 'anyAll' : 'any', params: {} });
      index += 1;
    } else if (char === '^' || char === '$') {
      flushLiterals();
      const line = flags.includes('m');
      const key: ExplainKey =
        char === '^' ? (line ? 'startLine' : 'start') : line ? 'endLine' : 'end';
      add(depth, char, { key, params: {} });
      index += 1;
    } else if (char === '*' || char === '+' || char === '?' || char === '{') {
      let source = char;
      let piece: Piece | undefined;
      if (char === '*') {
        piece = { key: 'zeroOrMore', params: {} };
      } else if (char === '+') {
        piece = { key: 'oneOrMore', params: {} };
      } else if (char === '?') {
        piece = { key: 'optional', params: {} };
      } else {
        const found = QUANTIFIER.exec(chars.slice(index).join(''));
        if (found !== null) {
          source = found[0];
          const min = Number(found[1]);
          if (found[2] === undefined) {
            piece = { key: 'exactly', params: { count: min } };
          } else if (found[3] === '') {
            piece = { key: 'atLeast', params: { count: min } };
          } else {
            piece = { key: 'between', params: { min, max: Number(found[3]) } };
          }
        }
      }
      if (piece === undefined) {
        // A brace that starts no repetition is an ordinary character.
        literals.push({ text: char, source: char });
        index += 1;
      } else {
        // The repetition belongs to the last character only: the text before it is a part of its own.
        flushLiterals(1);
        flushLiterals();
        index += Array.from(source).length;
        const lazy = chars[index] === '?';
        if (lazy) {
          source += '?';
          index += 1;
        }
        add(depth, source, piece, lazy);
      }
    } else {
      literals.push({ text: char, source: char });
      index += 1;
    }
  }
  flushLiterals();
  return items;
}
