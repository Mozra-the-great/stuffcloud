/**
 * The first half of the SQL formatter of our own: it reads the text into tokens (strings, quoted
 * names, comments, numbers, words, placeholders, operators) for a dialect. `layout.ts` lays them out.
 * It never needs to understand the whole grammar: text it does not recognise is a token of its own,
 * so any input, valid SQL or not, gives tokens that together are the whole text. It must not touch
 * the DOM.
 *
 * A formatter library was not an option: `sql-formatter` pulls `argparse` (Python-2.0), which the
 * license policy of this project does not allow in a production dependency tree.
 */

export const DIALECTS = [
  'standard',
  'postgresql',
  'mysql',
  'sqlite',
  'sqlserver',
  'oracle',
] as const;
export type Dialect = (typeof DIALECTS)[number];

export type KeywordCase = 'upper' | 'lower' | 'preserve';

export interface FormatOptions {
  readonly dialect: Dialect;
  readonly keywordCase: KeywordCase;
  /** Spaces per level, or `'tab'`. */
  readonly indent: number | 'tab';
  /** One line, no layout (a line comment still ends its line). */
  readonly minify: boolean;
}

export function isDialect(value: unknown): value is Dialect {
  return typeof value === 'string' && (DIALECTS as readonly string[]).includes(value);
}

// -- tokens --------------------------------------------------------------------------------

export type TokenKind =
  | 'word'
  | 'number'
  | 'string'
  | 'quoted'
  | 'placeholder'
  | 'operator'
  | 'punct'
  | 'lineComment'
  | 'blockComment';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** A line break lies between this token and the one before it. */
  readonly newlineBefore: boolean;
}

interface DialectRules {
  readonly hashComments: boolean;
  readonly backtickNames: boolean;
  readonly bracketNames: boolean;
  /** `"` opens a string, not a name (MySQL). */
  readonly doubleQuoteString: boolean;
  readonly backslashEscapes: boolean;
  readonly dollarQuotes: boolean;
  readonly placeholders: readonly RegExp[];
}

const COMMON_PLACEHOLDERS = [/^\?\d*/, /^%s/, /^%\([A-Za-z_]\w*\)s/];

const RULES: Readonly<Record<Dialect, DialectRules>> = {
  standard: {
    hashComments: false,
    backtickNames: false,
    bracketNames: false,
    doubleQuoteString: false,
    backslashEscapes: false,
    dollarQuotes: false,
    placeholders: [...COMMON_PLACEHOLDERS, /^:[A-Za-z_]\w*/, /^\$\d+/, /^@[A-Za-z_]\w*/],
  },
  postgresql: {
    hashComments: false,
    backtickNames: false,
    bracketNames: false,
    doubleQuoteString: false,
    backslashEscapes: false,
    dollarQuotes: true,
    placeholders: [/^\$\d+/, /^%s/, /^%\([A-Za-z_]\w*\)s/, /^:[A-Za-z_]\w*/],
  },
  mysql: {
    hashComments: true,
    backtickNames: true,
    bracketNames: false,
    doubleQuoteString: true,
    backslashEscapes: true,
    dollarQuotes: false,
    placeholders: [...COMMON_PLACEHOLDERS, /^@@?[A-Za-z_]\w*/],
  },
  sqlite: {
    hashComments: false,
    backtickNames: true,
    bracketNames: true,
    doubleQuoteString: false,
    backslashEscapes: false,
    dollarQuotes: false,
    placeholders: [...COMMON_PLACEHOLDERS, /^[:@$][A-Za-z_]\w*/],
  },
  sqlserver: {
    hashComments: false,
    backtickNames: false,
    bracketNames: true,
    doubleQuoteString: false,
    backslashEscapes: false,
    dollarQuotes: false,
    placeholders: [/^@@?[A-Za-z_]\w*/, /^\?/],
  },
  oracle: {
    hashComments: false,
    backtickNames: false,
    bracketNames: false,
    doubleQuoteString: false,
    backslashEscapes: false,
    dollarQuotes: false,
    placeholders: [/^:[A-Za-z_]\w*/, /^:\d+/],
  },
};

const OPERATORS = [
  '<<=',
  '>>=',
  '->>',
  '#>>',
  '<=>',
  '!~*',
  '...',
  '<=',
  '>=',
  '<>',
  '!=',
  '||',
  '&&',
  '::',
  '->',
  '#>',
  '=>',
  ':=',
  '!~',
  '~*',
  '<<',
  '>>',
  '@>',
  '<@',
  '?|',
  '?&',
  '**',
  '==',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '~',
  '&',
  '|',
  '^',
  '#',
  '@',
  '?',
  ':',
];

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_$·]/u;
const DIGIT = /[0-9]/;

/** Reads the text into tokens. It never fails: what it cannot read is a one-character operator. */
export function tokenize(sql: string, dialect: Dialect): Token[] {
  const rules = RULES[dialect];
  const tokens: Token[] = [];
  let position = 0;
  let newline = false;
  const push = (kind: TokenKind, text: string): void => {
    tokens.push({ kind, text, newlineBefore: newline });
    newline = false;
    position += text.length;
  };
  /** The end of a quoted run that starts at `from` (after its opening quote), or the end of the text. */
  const closeQuote = (
    from: number,
    quote: string,
    doubled: boolean,
    backslash: boolean,
  ): number => {
    let index = from;
    while (index < sql.length) {
      const char = sql.charAt(index);
      if (backslash && char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) {
        if (doubled && sql.charAt(index + 1) === quote) {
          index += 2;
          continue;
        }
        return index + 1;
      }
      index += 1;
    }
    return sql.length;
  };

  while (position < sql.length) {
    const char = sql.charAt(position);
    const rest = sql.slice(position, position + 64);
    if (char === '\n' || char === '\r') {
      newline = true;
      position += 1;
    } else if (/\s/.test(char)) {
      position += 1;
    } else if (rest.startsWith('--') || (rules.hashComments && char === '#')) {
      let end = position;
      while (end < sql.length && sql.charAt(end) !== '\n' && sql.charAt(end) !== '\r') {
        end += 1;
      }
      push('lineComment', sql.slice(position, end).trimEnd());
      position = end;
    } else if (rest.startsWith('/*')) {
      const close = sql.indexOf('*/', position + 2);
      const end = close === -1 ? sql.length : close + 2;
      const text = sql.slice(position, end);
      push('blockComment', text);
      if (/[\r\n]/.test(text)) {
        // A comment that spans lines ends a line.
        newline = true;
      }
    } else if (char === "'" || (char === '"' && rules.doubleQuoteString)) {
      push(
        'string',
        sql.slice(position, closeQuote(position + 1, char, true, rules.backslashEscapes)),
      );
    } else if (
      /^[EeNnBbXxUu]&?'/.test(rest.slice(0, 3)) &&
      !WORD_PART.test(sql.charAt(position - 1))
    ) {
      // A prefixed string: E'..', N'..', B'..', X'..', U&'..'.
      const quote = rest.indexOf("'");
      const escapes = rules.backslashEscapes || /^[Ee]/.test(char);
      push('string', sql.slice(position, closeQuote(position + quote + 1, "'", true, escapes)));
    } else if (char === '"') {
      push('quoted', sql.slice(position, closeQuote(position + 1, '"', true, false)));
    } else if (char === '`' && rules.backtickNames) {
      push('quoted', sql.slice(position, closeQuote(position + 1, '`', true, false)));
    } else if (char === '[' && rules.bracketNames) {
      const close = sql.indexOf(']', position + 1);
      push('quoted', sql.slice(position, close === -1 ? sql.length : close + 1));
    } else if (char === '$' && rules.dollarQuotes && /^\$[A-Za-z_]*\$/.test(rest)) {
      const tag = /^\$[A-Za-z_]*\$/.exec(rest)?.[0] ?? '$$';
      const close = sql.indexOf(tag, position + tag.length);
      push('string', sql.slice(position, close === -1 ? sql.length : close + tag.length));
    } else if (DIGIT.test(char) || (char === '.' && DIGIT.test(sql.charAt(position + 1)))) {
      const match = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
      push('number', match?.[0] ?? char);
    } else if (
      WORD_START.test(char) ||
      (dialect === 'sqlserver' && char === '#' && /^#{1,2}[\p{L}_]/u.test(rest))
    ) {
      let end = position + 1;
      while (char === '#' && sql.charAt(end) === '#') {
        end += 1;
      }
      while (end < sql.length && WORD_PART.test(sql.charAt(end))) {
        end += 1;
      }
      push('word', sql.slice(position, end));
    } else {
      const placeholder = rules.placeholders
        .map((pattern) => pattern.exec(rest)?.[0])
        .find((found) => found !== undefined && found !== '');
      if (placeholder !== undefined) {
        push('placeholder', placeholder);
      } else if ('(),;.[]'.includes(char)) {
        push('punct', char);
      } else {
        push('operator', OPERATORS.find((operator) => rest.startsWith(operator)) ?? char);
      }
    }
  }
  return tokens;
}
