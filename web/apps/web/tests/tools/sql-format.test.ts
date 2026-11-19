import { describe, expect, it } from 'vitest';
import { formatSql } from '../../src/tools/sql-formatter/layout.ts';
import {
  DIALECTS,
  isDialect,
  tokenize,
  type Dialect,
  type FormatOptions,
  type Token,
} from '../../src/tools/sql-formatter/tokens.ts';

const defaults: FormatOptions = {
  dialect: 'standard',
  keywordCase: 'upper',
  indent: 2,
  minify: false,
};

function format(sql: string, options: Partial<FormatOptions> = {}): string {
  return formatSql(sql, { ...defaults, ...options });
}

function kinds(sql: string, dialect: Dialect = 'standard'): [string, string][] {
  return tokenize(sql, dialect).map((token) => [token.kind, token.text]);
}

describe('dialects', () => {
  it('knows its dialects', () => {
    expect(DIALECTS).toEqual(['standard', 'postgresql', 'mysql', 'sqlite', 'sqlserver', 'oracle']);
    expect(DIALECTS.every(isDialect)).toBe(true);
    expect(isDialect('db2')).toBe(false);
    expect(isDialect(1)).toBe(false);
  });
});

describe('tokenize', () => {
  it('reads words, numbers, strings, operators and punctuation', () => {
    expect(kinds("select a.b, 1.5e3 + .5 from t where x <> 'it''s' and y >= 0x1F;")).toEqual([
      ['word', 'select'],
      ['word', 'a'],
      ['punct', '.'],
      ['word', 'b'],
      ['punct', ','],
      ['number', '1.5e3'],
      ['operator', '+'],
      ['number', '.5'],
      ['word', 'from'],
      ['word', 't'],
      ['word', 'where'],
      ['word', 'x'],
      ['operator', '<>'],
      ['string', "'it''s'"],
      ['word', 'and'],
      ['word', 'y'],
      ['operator', '>='],
      ['number', '0x1F'],
      ['punct', ';'],
    ]);
  });

  it('reads comments, and notes where a line break lay before a token', () => {
    const tokens = tokenize('a -- c1\nb /* c2 */ c\n/* c3\n c3 */ d', 'standard');
    expect(tokens.map((token) => [token.kind, token.text, token.newlineBefore])).toEqual([
      ['word', 'a', false],
      ['lineComment', '-- c1', false],
      ['word', 'b', true],
      ['blockComment', '/* c2 */', false],
      ['word', 'c', false],
      ['blockComment', '/* c3\n c3 */', true],
      ['word', 'd', true],
    ]);
  });

  it('keeps a quote that is never closed as one token to the end', () => {
    expect(kinds("x = 'abc")).toEqual([
      ['word', 'x'],
      ['operator', '='],
      ['string', "'abc"],
    ]);
    expect(kinds('x = "abc')).toEqual([
      ['word', 'x'],
      ['operator', '='],
      ['quoted', '"abc'],
    ]);
    expect(kinds('a /* never closed')).toEqual([
      ['word', 'a'],
      ['blockComment', '/* never closed'],
    ]);
    expect(kinds('a -- to the end')).toEqual([
      ['word', 'a'],
      ['lineComment', '-- to the end'],
    ]);
    expect(kinds('[a b', 'sqlserver')).toEqual([['quoted', '[a b']]);
    expect(kinds('$$ never', 'postgresql')).toEqual([['string', '$$ never']]);
  });

  it('reads the quoting of each dialect', () => {
    expect(kinds('"a b"')).toEqual([['quoted', '"a b"']]);
    expect(kinds('"a b"', 'mysql')).toEqual([['string', '"a b"']]);
    expect(kinds('`a b`', 'mysql')).toEqual([['quoted', '`a b`']]);
    expect(kinds('`a b`')).not.toEqual([['quoted', '`a b`']]);
    expect(kinds('[a b]', 'sqlserver')).toEqual([['quoted', '[a b]']]);
    expect(kinds('[a b]', 'sqlite')).toEqual([['quoted', '[a b]']]);
    expect(kinds('a[1]', 'postgresql')).toEqual([
      ['word', 'a'],
      ['punct', '['],
      ['number', '1'],
      ['punct', ']'],
    ]);
    expect(kinds("'a\\'b'", 'mysql')).toEqual([['string', "'a\\'b'"]]);
    expect(kinds("'a\\'b'")).toEqual([
      ['string', "'a\\'"],
      ['string', "b'"],
    ]);
    expect(kinds('# c\nx', 'mysql')).toEqual([
      ['lineComment', '# c'],
      ['word', 'x'],
    ]);
    expect(kinds('a # b')).toEqual([
      ['word', 'a'],
      ['operator', '#'],
      ['word', 'b'],
    ]);
    expect(kinds('$tag$ a $$ b $tag$', 'postgresql')).toEqual([['string', '$tag$ a $$ b $tag$']]);
    expect(kinds("E'a\\'b' N'x' X'1F' U&'d'", 'postgresql').map(([kind]) => kind)).toEqual([
      'string',
      'string',
      'string',
      'string',
    ]);
    expect(kinds('#tmp ##global', 'sqlserver')).toEqual([
      ['word', '#tmp'],
      ['word', '##global'],
    ]);
  });

  it('reads placeholders of each style', () => {
    expect(kinds('? ?1 %s %(name)s :name $1 @v', 'standard').map(([kind]) => kind)).toEqual([
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
    ]);
    expect(kinds('@@x', 'sqlserver')).toEqual([['placeholder', '@@x']]);
    expect(kinds('a::int', 'postgresql')).toEqual([
      ['word', 'a'],
      ['operator', '::'],
      ['word', 'int'],
    ]);
    expect(kinds('a->>b #>> c', 'postgresql').map(([, text]) => text)).toEqual([
      'a',
      '->>',
      'b',
      '#>>',
      'c',
    ]);
  });

  it('reads any text, and the tokens together are the whole text', () => {
    for (const text of ['\u{0}', '\u{ffff}', '😀 x', "''", '"', '`', '$', '\\', '~!^|&']) {
      for (const dialect of DIALECTS) {
        const joined = tokenize(text, dialect)
          .map((token: Token) => token.text)
          .join('');
        expect(joined.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
      }
    }
  });
});

const cases: { input: string; options: Partial<FormatOptions>; expected: string[] }[] = [
  {
    input: 'select a from t where x = 1 and (y = 2 or z = 3) and w in (1,2,3)',
    options: {},
    expected: [
      'SELECT',
      '  a',
      'FROM',
      '  t',
      'WHERE',
      '  x = 1',
      '  AND (y = 2 OR z = 3)',
      '  AND w IN (1, 2, 3)',
    ],
  },
  {
    input: "select a from t where a is not null and b not between 1 and 2 or c like 'x%'",
    options: {},
    expected: [
      'SELECT',
      '  a',
      'FROM',
      '  t',
      'WHERE',
      '  a IS NOT NULL',
      '  AND b NOT BETWEEN 1 AND 2',
      "  OR c LIKE 'x%'",
    ],
  },
  {
    input: 'select * from a join b using (id) cross join c inner join d on a.x=d.x',
    options: {},
    expected: [
      'SELECT',
      '  *',
      'FROM',
      '  a',
      'JOIN b USING (id)',
      'CROSS JOIN c',
      'INNER JOIN d ON a.x = d.x',
    ],
  },
  {
    input:
      'select count(*) over (partition by a order by b rows between unbounded preceding and current row) as n from t',
    options: {},
    expected: [
      'SELECT',
      '  count(*) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS n',
      'FROM',
      '  t',
    ],
  },
  {
    input: 'select extract(year from d), cast(x as varchar(10)), coalesce(a, b) from t',
    options: {},
    expected: [
      'SELECT',
      '  extract(year FROM d),',
      '  CAST(x AS VARCHAR(10)),',
      '  coalesce(a, b)',
      'FROM',
      '  t',
    ],
  },
  {
    input: 'select a from t order by a limit 5; -- done\nselect 2',
    options: {},
    expected: [
      'SELECT',
      '  a',
      'FROM',
      '  t',
      'ORDER BY',
      '  a',
      'LIMIT 5;',
      '',
      '-- done',
      'SELECT',
      '  2',
    ],
  },
  {
    input: '-- header\nselect 1 /* c */ , 2',
    options: {},
    expected: ['-- header', 'SELECT', '  1 /* c */,', '  2'],
  },
  {
    input: '/* a\n b */ select 1',
    options: {},
    expected: ['/* a', ' b */', 'SELECT', '  1'],
  },
  {
    input: 'select a, -- c1\n b -- c2\nfrom t',
    options: {},
    expected: ['SELECT', '  a, -- c1', '  b -- c2', 'FROM', '  t'],
  },
  {
    input: 'update t set a = 1 where b = 2 returning a',
    options: {},
    expected: ['UPDATE t', 'SET', '  a = 1', 'WHERE', '  b = 2', 'RETURNING', '  a'],
  },
  {
    input: "select 'it''s' as s, \"Quoted\" as q, `bt` from t",
    options: { dialect: 'mysql' },
    expected: ['SELECT', "  'it''s' AS s,", '  "Quoted" AS q,', '  `bt`', 'FROM', '  t'],
  },
  {
    input: 'select $1, :name, ? , @v from t',
    options: {},
    expected: ['SELECT', '  $1,', '  :name,', '  ?,', '  @v', 'FROM', '  t'],
  },
  {
    input: 'select [a b], x from [dbo].[t] with (nolock)',
    options: { dialect: 'sqlserver' },
    expected: ['SELECT', '  [a b],', '  x', 'FROM', '  [dbo].[t] WITH (NOLOCK)'],
  },
  {
    input: "select a#>>'{b}' , x::int, $$body$$ from t",
    options: { dialect: 'postgresql' },
    expected: ['SELECT', "  a #>> '{b}',", '  x::INT,', '  $$body$$', 'FROM', '  t'],
  },
  {
    input: 'select a from (select b from c) as d where e = 1',
    options: {},
    expected: [
      'SELECT',
      '  a',
      'FROM',
      '  (',
      '    SELECT',
      '      b',
      '    FROM',
      '      c',
      '  ) AS d',
      'WHERE',
      '  e = 1',
    ],
  },
  {
    input: 'insert into t select * from u',
    options: {},
    expected: ['INSERT INTO t', 'SELECT', '  *', 'FROM', '  u'],
  },
  {
    input: 'select 1; ; select 2',
    options: {},
    expected: ['SELECT', '  1;', '', ';', '', 'SELECT', '  2'],
  },
  {
    input: 'select a from t for update',
    options: {},
    expected: ['SELECT', '  a', 'FROM', '  t FOR UPDATE'],
  },
  {
    input: 'SELECT TOP 10 a FROM t',
    options: { dialect: 'sqlserver' },
    expected: ['SELECT TOP 10', '  a', 'FROM', '  t'],
  },
  {
    input: 'select a from t where a = -1 and b = - c and d = +1',
    options: {},
    expected: ['SELECT', '  a', 'FROM', '  t', 'WHERE', '  a = -1', '  AND b = -c', '  AND d = +1'],
  },
  {
    input: 'select 1.5e3, .5, 0x1F, a.b.c, t.* from t',
    options: {},
    expected: ['SELECT', '  1.5e3,', '  .5,', '  0x1F,', '  a.b.c,', '  t.*', 'FROM', '  t'],
  },
  {
    input: "select a from t where x = 'unterminated",
    options: {},
    expected: ['SELECT', '  a', 'FROM', '  t', 'WHERE', "  x = 'unterminated"],
  },
  {
    input: 'select )) from (( x',
    options: {},
    expected: ['SELECT', '  ))', 'FROM', '  ((x'],
  },
  {
    input: 'select Name, Count from t',
    options: { keywordCase: 'lower' },
    expected: ['select', '  Name,', '  Count', 'from', '  t'],
  },
  {
    input: 'select Name from t',
    options: { keywordCase: 'preserve' },
    expected: ['select', '  Name', 'from', '  t'],
  },
  {
    input: 'select a from t where x = 1',
    options: { indent: 4 },
    expected: ['SELECT', '    a', 'FROM', '    t', 'WHERE', '    x = 1'],
  },
  {
    input: 'select a from t where x = 1',
    options: { indent: 'tab' },
    expected: ['SELECT', '\ta', 'FROM', '\tt', 'WHERE', '\tx = 1'],
  },
  {
    input: '',
    options: {},
    expected: [''],
  },
  {
    input: '   \n  ',
    options: {},
    expected: [''],
  },
  {
    input: 'with recursive r as (select 1) select * from r',
    options: {},
    expected: [
      'WITH RECURSIVE',
      '  r AS (',
      '    SELECT',
      '      1',
      '  )',
      'SELECT',
      '  *',
      'FROM',
      '  r',
    ],
  },
  {
    input: 'create index i on t (a, b)',
    options: {},
    expected: ['CREATE INDEX i ON t(a, b)'],
  },
  {
    input: 'select a from t where x = case when y then 1 else 2 end and z = 1',
    options: {},
    expected: [
      'SELECT',
      '  a',
      'FROM',
      '  t',
      'WHERE',
      '  x = CASE',
      '    WHEN y THEN 1',
      '    ELSE 2',
      '  END',
      '  AND z = 1',
    ],
  },
  {
    input: 'select sum(case when a then 1 else 0 end) from t',
    options: {},
    expected: ['SELECT', '  sum(CASE WHEN a THEN 1 ELSE 0 END)', 'FROM', '  t'],
  },
  {
    input: 'alter table t add column c int; drop table t',
    options: {},
    expected: ['ALTER TABLE t ADD COLUMN c INT;', '', 'DROP TABLE t'],
  },
];

describe('formatSql: layout', () => {
  it.each(cases)('lays out $input', ({ input, options, expected }) => {
    expect(format(input, options)).toBe(expected.join('\n'));
  });
});

describe('formatSql: options', () => {
  it('writes the keywords in upper case, lower case or as they are', () => {
    expect(format('Select a From T', { keywordCase: 'upper' })).toBe('SELECT\n  a\nFROM\n  T');
    expect(format('Select A From t', { keywordCase: 'lower' })).toBe('select\n  A\nfrom\n  t');
    expect(format('Select a From T', { keywordCase: 'preserve' })).toBe('Select\n  a\nFrom\n  T');
  });

  it('keeps the case of names, strings and function calls', () => {
    expect(format('select Count(x), left(Name, 2), \'Select\' as "From" from T')).toBe(
      ['SELECT', '  Count(x),', '  left(Name, 2),', '  \'Select\' AS "From"', 'FROM', '  T'].join(
        '\n',
      ),
    );
  });

  it('indents with the width asked for, or a tab', () => {
    expect(format('select a from t', { indent: 4 })).toBe('SELECT\n    a\nFROM\n    t');
    expect(format('select a from t', { indent: 'tab' })).toBe('SELECT\n\ta\nFROM\n\tt');
    expect(format('select a from (select b from c) d', { indent: 'tab' })).toBe(
      'SELECT\n\ta\nFROM\n\t(\n\t\tSELECT\n\t\t\tb\n\t\tFROM\n\t\t\tc\n\t) d',
    );
  });

  it('writes one line when asked, with a line comment still ending its line', () => {
    expect(format('select a,\n b\nfrom t\nwhere x=1 and y in (select 1)', { minify: true })).toBe(
      'SELECT a, b FROM t WHERE x = 1 AND y IN (SELECT 1)',
    );
    expect(format('select a -- c\nfrom t', { minify: true })).toBe('SELECT a -- c\nFROM t');
    expect(format('select 1; select 2;', { minify: true })).toBe('SELECT 1; SELECT 2;');
    expect(format('select 1 /* a\nb */ , 2', { minify: true })).toBe('SELECT 1 /* a\nb */, 2');
    expect(format('select -1, - a, 2 - 1, count(*), t.* from t', { minify: true })).toBe(
      'SELECT -1, -a, 2 - 1, count(*), t.* FROM t',
    );
  });

  it('gives nothing for nothing', () => {
    expect(format('')).toBe('');
    expect(format(' \n\t ')).toBe('');
    expect(format('', { minify: true })).toBe('');
  });
});

describe('formatSql: details', () => {
  it('keeps a comment where it was: at the end of a line, or on a line of its own', () => {
    expect(format('select a, -- first\n b /* x */ from t')).toBe(
      ['SELECT', '  a, -- first', '  b /* x */', 'FROM', '  t'].join('\n'),
    );
    expect(format('select\n-- own line\na\nfrom t')).toBe(
      ['SELECT', '  -- own line', '  a', 'FROM', '  t'].join('\n'),
    );
    expect(format('-- top\n-- more\nselect 1')).toBe(
      ['-- top', '-- more', 'SELECT', '  1'].join('\n'),
    );
  });

  it('never lets a token slip into a line comment', () => {
    for (const sql of [
      'select (1 -- c\n)',
      'select 1 -- c\n;',
      'select f(a -- c\n, b)',
      'select a -- c\n, b',
    ]) {
      for (const line of format(sql).split('\n')) {
        const at = line.indexOf('--');
        if (at !== -1) {
          expect(line.slice(at)).toBe('-- c');
        }
      }
    }
  });

  it('does not break a BETWEEN, and does break the other ANDs and ORs', () => {
    expect(format('select 1 from t where a between 1 and 2 and b between 3 and 4 or c = 5')).toBe(
      [
        'SELECT',
        '  1',
        'FROM',
        '  t',
        'WHERE',
        '  a BETWEEN 1 AND 2',
        '  AND b BETWEEN 3 AND 4',
        '  OR c = 5',
      ].join('\n'),
    );
  });

  it('keeps a call, a cast and a sized type together', () => {
    expect(format('select cast(a as numeric(10,2)), f(g(x)), a::int from t')).toBe(
      ['SELECT', '  CAST(a AS NUMERIC(10, 2)),', '  f(g(x)),', '  a::INT', 'FROM', '  t'].join(
        '\n',
      ),
    );
  });

  it('keeps a window or an EXTRACT on one line, because those are not clauses', () => {
    expect(
      format('select sum(x) over (partition by a order by b), extract(year from d) from t'),
    ).toBe(
      [
        'SELECT',
        '  sum(x) OVER (PARTITION BY a ORDER BY b),',
        '  extract(year FROM d)',
        'FROM',
        '  t',
      ].join('\n'),
    );
  });

  it('puts the statements apart with an empty line, and nested queries one level deeper', () => {
    expect(format('select 1; select (select 2) as x;')).toBe(
      ['SELECT', '  1;', '', 'SELECT', '  (', '    SELECT', '      2', '  ) AS x;'].join('\n'),
    );
  });

  it('treats a stray parenthesis as an ordinary token', () => {
    expect(format('select ) from t')).toBe(['SELECT', '  )', 'FROM', '  t'].join('\n'));
    expect(format('select (1 from t')).toBe(
      ['SELECT', '  (1 FROM t'].join(String.fromCharCode(10)),
    );
  });

  it('does not treat FOR UPDATE, WITH TIES or WITH (NOLOCK) as clauses', () => {
    expect(format('select a from t for update')).toContain('t FOR UPDATE');
    expect(format('select a from t with (nolock)', { dialect: 'sqlserver' })).toContain(
      't WITH (NOLOCK)',
    );
    expect(format('select a from t order by a fetch first 1 rows with ties')).toContain(
      'WITH TIES',
    );
  });

  it('writes unusual statements without losing a token', () => {
    const sql = [
      'create table if not exists "a b" (id serial primary key, n numeric(5,2) default -1, check (n > 0))',
      'merge into t using s on t.id = s.id when matched then update set a = s.a',
      "select a from t where b = any (array[1,2]) and c ~ 'x' and d @> '{}'",
    ].join(';\n');
    const out = format(sql, { dialect: 'postgresql' });
    expect(tokenize(out, 'postgresql').map((token) => token.text.toLowerCase())).toEqual(
      tokenize(sql, 'postgresql').map((token) => token.text.toLowerCase()),
    );
  });
});

const CORPUS = [
  'select a, b from t where x = 1',
  'select \'a;b\', "c--d", `e` from t -- trailing',
  'with x as (select 1 union select 2) select * from x',
  'insert into t (a, b) values (1, 2), (3, 4) returning a',
  'update t set a = a + 1, b = b - 1 where c in (select d from e where f is null)',
  "delete from t where a between 1 and 2 or b like '%x' escape '\\\\'",
  'select case when a > 1 then 2 when a < 0 then -1 else 0 end from t',
  'create table t (id int, name varchar(10) not null, primary key (id))',
  'select a.*, count(*) over (partition by b) from a left outer join b on a.id = b.id and b.x = ? where :p',
  'select 1 /* c */; -- d\nselect 2',
  'select x from t order by 1 desc nulls last limit 10 offset 5',
  'select ((1)), f((2), (3)), [4], {5} from t',
  "select '😀', 'ü' from \"Täble\"",
];

/** A deterministic generator (no extra dependency). */
function random(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('property: only white space and keyword case change', () => {
  const variants: Partial<FormatOptions>[] = [
    {},
    { minify: true },
    { indent: 4, keywordCase: 'lower' },
    { indent: 'tab', keywordCase: 'preserve' },
  ];

  function words(sql: string, dialect: Dialect): string[] {
    return tokenize(sql, dialect).map((token) =>
      token.kind === 'word' ? token.text.toLowerCase() : token.text,
    );
  }

  /** A damaged statement, to meet text that is not valid SQL. */
  function damaged(sql: string, seed: number): string {
    const next = random(seed);
    const cut = Math.floor(next() * (sql.length + 1));
    const junk = [
      "'",
      '"',
      '(',
      ')',
      '/*',
      '--',
      ';',
      ',',
      '`',
      '[',
      ']',
      '$$',
      '\n',
      '::',
      ' and ',
      ' select ',
    ];
    const piece = junk[Math.floor(next() * junk.length)] ?? '';
    return next() < 0.3 ? sql.slice(0, cut) : `${sql.slice(0, cut)}${piece}${sql.slice(cut)}`;
  }

  it.each(DIALECTS)('keeps every token and is stable when formatted twice (%s)', (dialect) => {
    const inputs = [
      ...CORPUS,
      ...CORPUS.flatMap((sql, index) => [damaged(sql, index + 1), damaged(sql, index + 101)]),
    ];
    for (const sql of inputs) {
      for (const variant of variants) {
        const options = { ...defaults, ...variant, dialect };
        const once = formatSql(sql, options);
        expect(words(once, dialect), `${sql} -> ${once}`).toEqual(words(sql, dialect));
        expect(formatSql(once, options), once).toBe(once);
      }
    }
  });

  it('never throws, whatever the text', () => {
    const next = random(42);
    const parts =
      'select from where ( ) , ; \' " ` [ ] -- /* */ $$ :: @ ? 1 a . * - + and or case when end'.split(
        ' ',
      );
    for (let round = 0; round < 400; round += 1) {
      const text = Array.from(
        { length: Math.floor(next() * 30) },
        () => parts[Math.floor(next() * parts.length)] ?? '',
      ).join(' ');
      for (const dialect of DIALECTS) {
        expect(() => formatSql(text, { ...defaults, dialect })).not.toThrow();
        expect(() => formatSql(text, { ...defaults, dialect, minify: true })).not.toThrow();
      }
    }
  });
});

describe('large and deep input', () => {
  it('formats a long statement in one line quickly', () => {
    const sql = `select ${Array.from({ length: 100_000 }, (_, index) => `a${String(index)}`).join(' + ')} from t`;
    const started = performance.now();
    const out = format(sql, { minify: true });
    expect(out.startsWith('SELECT a0 + a1')).toBe(true);
    expect(format(sql).split(String.fromCharCode(10)).length).toBeGreaterThan(3);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('does not indent nested queries without end', () => {
    const sql = `${'(select '.repeat(2000)}1${')'.repeat(2000)}`;
    const out = format(sql);
    // The indentation stops growing: the text stays about as long as it was.
    expect(out.length).toBeLessThan(sql.length * 3);
    expect(tokenize(out, 'standard').length).toBe(tokenize(sql, 'standard').length);
  });
});
