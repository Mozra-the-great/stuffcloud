import { tokenize, type Dialect, type FormatOptions, type Token } from './tokens.ts';

// -- keywords ------------------------------------------------------------------------------

const KEYWORDS = new Set(
  (
    'add all alter and any as asc between by case cast check column constraint create cross cube current database default delete desc distinct drop else end except exists ' +
    'false fetch filter first following for foreign from full group grouping having if in index inner insert intersect into is join key last left like limit natural not null nulls ' +
    'offset on only or order outer over partition preceding primary range recursive references replace right rollup row rows select set some table temp temporary then ties to true truncate ' +
    'union unique unbounded update using values view when where window with within without work begin commit rollback transaction savepoint release grant revoke ' +
    'int integer bigint smallint decimal numeric float double real char varchar date time timestamp boolean ' +
    'escape collate interval cascade restrict returns return language function procedure trigger materialized qualify lateral unnest isnull notnull'
  ).split(' '),
);

const DIALECT_KEYWORDS: Readonly<Record<Dialect, readonly string[]>> = {
  standard: [],
  postgresql: [
    'ilike',
    'returning',
    'serial',
    'bigserial',
    'conflict',
    'do',
    'nothing',
    'similar',
    'jsonb',
    'json',
    'uuid',
    'text',
    'bytea',
  ],
  mysql: [
    'straight_join',
    'regexp',
    'rlike',
    'auto_increment',
    'unsigned',
    'engine',
    'duplicate',
    'ignore',
    'tinyint',
    'mediumint',
    'longtext',
    'mediumtext',
    'datetime',
  ],
  sqlite: [
    'glob',
    'pragma',
    'autoincrement',
    'rowid',
    'indexed',
    'vacuum',
    'abort',
    'fail',
    'conflict',
    'do',
    'nothing',
  ],
  sqlserver: [
    'top',
    'output',
    'nolock',
    'identity',
    'exec',
    'execute',
    'declare',
    'nvarchar',
    'datetime2',
    'merge',
    'matched',
    'apply',
    'percent',
    'ties',
  ],
  oracle: [
    'dual',
    'rownum',
    'connect',
    'prior',
    'start',
    'varchar2',
    'number',
    'minus',
    'merge',
    'matched',
  ],
};

/** Words that are also function names: with a `(` after them they are a call, not a keyword. */
const CALLABLE = new Set(['left', 'right', 'replace', 'if', 'insert', 'truncate']);
/** Keywords written like a call, without a space before the `(`: `CAST(x AS INT)`, `VARCHAR(255)`. */
const KEYWORD_CALLS = new Set([
  'cast',
  'char',
  'varchar',
  'nchar',
  'nvarchar',
  'varchar2',
  'number',
  'numeric',
  'decimal',
  'float',
  'binary',
  'varbinary',
  'bit',
  'time',
  'timestamp',
  'datetime2',
  'datetime',
]);

function isKeyword(word: string, dialect: Dialect): boolean {
  const lower = word.toLowerCase();
  return KEYWORDS.has(lower) || DIALECT_KEYWORDS[dialect].includes(lower);
}

// -- clauses -------------------------------------------------------------------------------

type ClauseKind = 'block' | 'inline';

/** The phrases that open a clause on a line of their own. */
const CLAUSES: readonly { readonly words: readonly string[]; readonly kind: ClauseKind }[] = [
  { words: ['select'], kind: 'block' },
  { words: ['from'], kind: 'block' },
  { words: ['where'], kind: 'block' },
  { words: ['group', 'by'], kind: 'block' },
  { words: ['having'], kind: 'block' },
  { words: ['qualify'], kind: 'block' },
  { words: ['order', 'by'], kind: 'block' },
  { words: ['values'], kind: 'block' },
  { words: ['set'], kind: 'block' },
  { words: ['returning'], kind: 'block' },
  { words: ['with'], kind: 'block' },
  { words: ['limit'], kind: 'inline' },
  { words: ['offset'], kind: 'inline' },
  { words: ['fetch'], kind: 'inline' },
  { words: ['insert', 'into'], kind: 'inline' },
  { words: ['replace', 'into'], kind: 'inline' },
  { words: ['delete', 'from'], kind: 'inline' },
  { words: ['update'], kind: 'inline' },
  { words: ['create'], kind: 'inline' },
  { words: ['alter', 'table'], kind: 'inline' },
  { words: ['drop'], kind: 'inline' },
  { words: ['truncate'], kind: 'inline' },
];

const JOIN_PREFIX = new Set(['inner', 'left', 'right', 'full', 'cross', 'natural', 'outer']);
const SET_OPERATORS = new Set(['union', 'intersect', 'except', 'minus']);
/** Words that may follow `SELECT` or `WITH` on the same line. */
const MODIFIERS = new Set([
  'distinct',
  'all',
  'top',
  'percent',
  'ties',
  'distinctrow',
  'recursive',
]);
/** What these words are the second half of: `FOR UPDATE`, `ON DUPLICATE KEY UPDATE`, `DO UPDATE`. */
const NOT_A_CLAUSE_AFTER = new Set(['for', 'key', 'do', 'no']);
const CONDITION_CLAUSES = new Set(['where', 'having', 'join', 'qualify']);

type Phrase =
  | {
      readonly kind: 'clause';
      readonly length: number;
      readonly name: string;
      readonly clause: ClauseKind;
    }
  | { readonly kind: 'join' | 'setop'; readonly length: number };

function wordsAt(tokens: readonly Token[], index: number): string[] {
  const words: string[] = [];
  for (let at = index; at < tokens.length && words.length < 5; at += 1) {
    const token = tokens[at];
    if (token?.kind !== 'word') {
      break;
    }
    words.push(token.text.toLowerCase());
  }
  return words;
}

/** The clause, join or set operator that starts at `index`, if one does. */
function phraseAt(
  tokens: readonly Token[],
  index: number,
  frameHasClause: boolean,
): Phrase | undefined {
  const words = wordsAt(tokens, index);
  const [first] = words;
  if (first === undefined) {
    return undefined;
  }
  const next = tokens[index + 1];
  if (CALLABLE.has(first) && next?.text === '(' && next.kind === 'punct') {
    return undefined;
  }
  if (SET_OPERATORS.has(first)) {
    const quantifier = words[1] === 'all' || words[1] === 'distinct';
    return { kind: 'setop', length: quantifier ? 2 : 1 };
  }
  if (JOIN_PREFIX.has(first) || first === 'join' || first === 'straight_join') {
    let length = 0;
    while (length < words.length && JOIN_PREFIX.has(words[length] ?? '')) {
      length += 1;
    }
    if (
      words[length] === 'join' ||
      words[length] === 'apply' ||
      (length === 0 && first === 'straight_join')
    ) {
      return { kind: 'join', length: length + 1 };
    }
    return undefined;
  }
  const before = tokens[index - 1];
  if (before?.kind === 'word' && NOT_A_CLAUSE_AFTER.has(before.text.toLowerCase())) {
    return undefined;
  }
  // `WITH` opens a statement; later it is `WITH TIES`, `WITH (NOLOCK)`, `WITH CHECK OPTION`.
  if (first === 'with' && frameHasClause) {
    return undefined;
  }
  for (const clause of CLAUSES) {
    if (clause.words.every((word, offset) => words[offset] === word)) {
      return {
        kind: 'clause',
        length: clause.words.length,
        name: clause.words.join(' '),
        clause: clause.kind,
      };
    }
  }
  return undefined;
}

// -- spacing -------------------------------------------------------------------------------

/** An operator that takes one operand only, judged from what came before it. */
function isUnary(text: string, previous: Token | undefined, dialect: Dialect): boolean {
  if (text !== '-' && text !== '+' && text !== '~' && text !== '!') {
    return false;
  }
  if (previous === undefined || previous.kind === 'operator') {
    return true;
  }
  if (previous.kind === 'punct') {
    return previous.text === '(' || previous.text === ',' || previous.text === '[';
  }
  return (
    previous.kind === 'word' &&
    isKeyword(previous.text, dialect) &&
    !['null', 'true', 'false', 'end'].includes(previous.text.toLowerCase())
  );
}

/** Whether a space belongs between two neighbours. `opening`: the token before asks for a space before `(`. */
function spaceBetween(previous: Token, token: Token, opening: boolean): boolean {
  const before = previous.text;
  const after = token.text;
  if (token.kind === 'punct') {
    if (after === ',' || after === ';' || after === '.' || after === ')' || after === ']') {
      return false;
    }
    if (after === '[') {
      return !(
        previous.kind === 'word' ||
        previous.kind === 'quoted' ||
        before === ')' ||
        before === ']'
      );
    }
    if (after === '(') {
      if (previous.kind === 'punct') {
        return !(before === '(' || before === '[' || before === '.');
      }
      if (previous.kind === 'operator') {
        return before !== '::';
      }
      if (previous.kind === 'word' || previous.kind === 'quoted') {
        return opening;
      }
      return true;
    }
  }
  if (previous.kind === 'punct') {
    return !(before === '(' || before === '.' || before === '[');
  }
  if (previous.kind === 'operator' && before === '::') {
    return false;
  }
  return !(token.kind === 'operator' && after === '::');
}

function caseOf(
  token: Token,
  keywordCase: FormatOptions['keywordCase'],
  dialect: Dialect,
  call: boolean,
  force = false,
): string {
  if (
    token.kind !== 'word' ||
    keywordCase === 'preserve' ||
    !(force || isKeyword(token.text, dialect))
  ) {
    return token.text;
  }
  if (call && CALLABLE.has(token.text.toLowerCase())) {
    return token.text;
  }
  return keywordCase === 'upper' ? token.text.toUpperCase() : token.text.toLowerCase();
}

/** Nested queries are indented this many levels at most. */
const MAX_INDENT_LEVELS = 64;

// -- layout --------------------------------------------------------------------------------

interface Frame {
  /** Indent level of the clause keywords of this frame. */
  readonly base: number;
  /** `root` and `sub` lay out clauses; `inline` is a call or a list on one line; `list` has one item a line. */
  readonly kind: 'root' | 'sub' | 'inline' | 'list';
  /** Indent level of the line the opening parenthesis was on. */
  readonly parentIndent: number;
  clause: string;
  clauseKind: ClauseKind;
  /** Indent of the lines inside the current clause. */
  contentIndent: number;
  /** Open `BETWEEN`s: their `AND` is not a break. */
  between: number;
  /** Indent levels of the open `CASE`s. */
  cases: number[];
}

function frameOf(kind: Frame['kind'], base: number, parentIndent: number): Frame {
  return {
    base,
    kind,
    parentIndent,
    clause: '',
    clauseKind: 'inline',
    contentIndent: base + 1,
    between: 0,
    cases: [],
  };
}

/**
 * Lays the tokens out, or (`options.minify`) writes them on one line with the spacing rules alone.
 * Only white space and keyword case change; the tokens stay the same.
 */
export function formatSql(sql: string, options: FormatOptions): string {
  const tokens = tokenize(sql, options.dialect);
  const { dialect, keywordCase } = options;
  const compact = options.minify;
  const unit = compact ? '' : options.indent === 'tab' ? '\t' : ' '.repeat(options.indent);
  const lines: string[] = [];
  let line = '';
  /** Whether the line has more than its indentation (kept, so that a long line is not searched again and again). */
  let hasContent = false;
  let lineIndent = 0;
  /** The last token written on this line, as the spacing rules see it. */
  let previous: Token | undefined;
  let previousOpens = false;
  /** Indent of the line the next token starts, when it must start a new one. */
  let pending: number | undefined;
  let nameBeforeList = false;
  let creatingTable = false;
  /** How many words after `SELECT` or `WITH` are still part of its line; -1: none. */
  let modifiers = -1;

  const root = frameOf('root', 0, 0);
  const stack: Frame[] = [root];
  const top = (): Frame => stack[stack.length - 1] ?? root;

  const flush = (): void => {
    if (hasContent) {
      lines.push(line.trimEnd());
    }
    line = '';
    hasContent = false;
  };
  const startLine = (indent: number): void => {
    pending = undefined;
    if (compact) {
      return;
    }
    flush();
    lineIndent = indent;
    line = unit.repeat(indent);
    previous = undefined;
    previousOpens = false;
  };
  const open = (): void => {
    if (pending !== undefined) {
      startLine(pending);
    }
  };
  const write = (token: Token, text: string, opens: boolean, asksSpace = false): void => {
    if (
      previous !== undefined &&
      hasContent &&
      spaceBetween(previous, token, asksSpace || previousOpens)
    ) {
      line += ' ';
    }
    line += text;
    hasContent = true;
    previous = token;
    previousOpens = opens;
  };
  /** Writes the words of a phrase (`GROUP BY`) with the case rule. */
  const writePhrase = (at: number, length: number): void => {
    for (let offset = 0; offset < length; offset += 1) {
      const part = tokens[at + offset];
      if (part !== undefined) {
        write(part, caseOf(part, keywordCase, dialect, false, true), true);
      }
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    const next = tokens[index + 1];
    const frame = top();
    const lower = token.text.toLowerCase();
    const layoutFrame = frame.kind === 'root' || frame.kind === 'sub';

    if (
      previous?.kind === 'lineComment' &&
      token.kind !== 'lineComment' &&
      token.kind !== 'blockComment'
    ) {
      // Nothing may follow a line comment on its line, not even a `,` or a `;`.
      open();
    }

    if (token.kind === 'lineComment' || token.kind === 'blockComment') {
      if (!compact && (token.newlineBefore || !hasContent)) {
        // A comment on a line of its own stays there; what follows starts a new line.
        const indent = pending ?? (!hasContent && layoutFrame ? frame.base : lineIndent);
        startLine(indent);
        line += token.text;
        hasContent = true;
        pending = indent;
      } else {
        line += `${hasContent ? ' ' : ''}${token.text}`;
        hasContent = true;
        if (token.kind === 'lineComment') {
          // Nothing may follow a line comment on its line.
          if (compact) {
            flush();
            previous = undefined;
          } else {
            pending ??= lineIndent;
          }
        }
      }
      if (token.kind === 'lineComment' && compact) {
        previous = undefined;
      } else {
        previous = token;
      }
      previousOpens = false;
      continue;
    }

    if (token.kind === 'word' && layoutFrame) {
      const phrase = phraseAt(tokens, index, frame.clause !== '');
      if (phrase?.kind === 'setop') {
        startLine(frame.base);
        writePhrase(index, phrase.length);
        index += phrase.length - 1;
        startLine(frame.base);
        frame.clause = 'setop';
        frame.clauseKind = 'inline';
        modifiers = -1;
        continue;
      }
      if (phrase?.kind === 'join') {
        startLine(frame.base);
        writePhrase(index, phrase.length);
        index += phrase.length - 1;
        frame.clause = 'join';
        frame.clauseKind = 'inline';
        frame.contentIndent = frame.base + 1;
        modifiers = -1;
        continue;
      }
      if (phrase?.kind === 'clause') {
        startLine(frame.base);
        writePhrase(index, phrase.length);
        index += phrase.length - 1;
        frame.clause = phrase.name;
        frame.clauseKind = phrase.clause;
        frame.contentIndent = frame.base + 1;
        frame.between = 0;
        nameBeforeList = phrase.name === 'insert into' || phrase.name === 'replace into';
        creatingTable = false;
        if (phrase.name === 'create') {
          const words = wordsAt(tokens, index + 1);
          creatingTable = words.slice(0, 4).includes('table');
          nameBeforeList = creatingTable;
        }
        modifiers = phrase.name === 'select' || phrase.name === 'with' ? 0 : -1;
        if (phrase.clause === 'block') {
          pending = frame.contentIndent;
        }
        continue;
      }
    }

    // `SELECT DISTINCT a`, `SELECT TOP 10 a`, `WITH RECURSIVE x`: these stay on the keyword's line.
    if (modifiers >= 0 && modifiers < 3 && pending !== undefined) {
      if (token.kind === 'word' && MODIFIERS.has(lower)) {
        modifiers += 1;
        write(token, caseOf(token, keywordCase, dialect, false), true);
        continue;
      }
      if (
        token.kind === 'number' &&
        previous?.kind === 'word' &&
        previous.text.toLowerCase() === 'top'
      ) {
        write(token, token.text, false);
        continue;
      }
    }
    modifiers = -1;

    if (token.kind === 'punct' && token.text === '(') {
      open();
      const following = wordsAt(tokens, index + 1)[0];
      // Past this depth a query is no longer indented further (the indentation alone would grow without bound).
      const sub =
        stack.length < MAX_INDENT_LEVELS && (following === 'select' || following === 'with');
      const list = !sub && creatingTable && frame.kind === 'root';
      write(token, '(', false, nameBeforeList);
      nameBeforeList = false;
      const here = lineIndent;
      if (sub || list) {
        if (list) {
          creatingTable = false;
        }
        stack.push(frameOf(sub ? 'sub' : 'list', here + 1, here));
        pending = here + 1;
      } else {
        stack.push(frameOf('inline', here, here));
      }
      continue;
    }

    if (token.kind === 'punct' && token.text === ')') {
      if (stack.length > 1) {
        const closing = stack.pop();
        if (closing?.kind === 'sub' || closing?.kind === 'list') {
          startLine(closing.parentIndent);
        }
        pending = undefined;
      } else {
        // A `)` that closes nothing is an ordinary token.
        open();
      }
      write(token, ')', false);
      continue;
    }

    if (token.kind === 'punct' && token.text === ',') {
      pending = undefined;
      write(token, ',', false);
      if (frame.kind === 'list') {
        pending = frame.base;
      } else if (layoutFrame && frame.clauseKind === 'block') {
        pending = frame.contentIndent;
      }
      continue;
    }

    if (token.kind === 'punct' && token.text === ';') {
      pending = undefined;
      write(token, ';', false);
      if (!compact) {
        flush();
        lines.push('');
        lineIndent = 0;
        previous = undefined;
      }
      stack.length = 1;
      root.clause = '';
      root.clauseKind = 'inline';
      root.between = 0;
      root.cases = [];
      nameBeforeList = false;
      creatingTable = false;
      continue;
    }

    if (token.kind === 'word') {
      if (lower === 'between') {
        frame.between += 1;
      } else if (lower === 'and' && frame.between > 0) {
        frame.between -= 1;
      } else if (
        (lower === 'and' || lower === 'or') &&
        layoutFrame &&
        frame.cases.length === 0 &&
        CONDITION_CLAUSES.has(frame.clause)
      ) {
        startLine(frame.clause === 'join' ? frame.base + 1 : frame.contentIndent);
      } else if ((lower === 'when' || lower === 'else') && layoutFrame && frame.cases.length > 0) {
        startLine((frame.cases[frame.cases.length - 1] ?? 0) + 1);
      } else if (lower === 'end' && frame.cases.length > 0) {
        const indent = frame.cases.pop() ?? 0;
        if (layoutFrame) {
          startLine(indent);
        }
      }
      open();
      if (lower === 'case') {
        frame.cases.push(lineIndent);
      }
      const call = next?.kind === 'punct' && next.text === '(';
      const opens =
        isKeyword(token.text, dialect) &&
        !(call && (CALLABLE.has(lower) || KEYWORD_CALLS.has(lower)));
      write(token, caseOf(token, keywordCase, dialect, call), opens);
      continue;
    }

    open();
    if (token.kind === 'operator') {
      const unary = isUnary(token.text, previous, dialect);
      write(token, token.text, false);
      if (unary) {
        // The operand follows without a space: `-1`.
        previous = { kind: 'punct', text: '(', newlineBefore: false };
      }
      continue;
    }
    write(token, token.text, false);
  }
  flush();
  while (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}
