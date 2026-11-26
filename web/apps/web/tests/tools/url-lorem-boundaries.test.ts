import { describe, expect, it } from 'vitest';
import {
  CLASSIC_OPENING,
  LOREM_UNITS,
  WORDS,
  drawSentence,
  generateLorem,
} from '../../src/tools/lorem/generate.ts';
import {
  MODES,
  decodeText,
  encodeText,
  type DecodeResult,
  type EncodeMode,
} from '../../src/tools/url/url.ts';

describe('the URL tool modes', () => {
  it('are component, uri and form, in that order', () => {
    expect([...MODES]).toEqual(['component', 'uri', 'form']);
  });
});

describe('encodeText in form mode', () => {
  it('writes the characters that encodeURIComponent keeps as two upper-case hex digits', () => {
    expect(encodeText("!'()~", 'form')).toEqual({ ok: true, text: '%21%27%28%29%7E' });
    expect(encodeText("a b!c'd", 'form')).toEqual({ ok: true, text: 'a+b%21c%27d' });
    expect(encodeText('*-._', 'form')).toEqual({ ok: true, text: '*-._' });
  });

  it('keeps those characters in the other modes', () => {
    expect(encodeText("!'()~", 'component')).toEqual({ ok: true, text: "!'()~" });
    expect(encodeText("!'()~ ", 'uri')).toEqual({ ok: true, text: "!'()~%20" });
  });
});

/** What decoding has to give, worked out one character at a time. */
function reference(text: string, mode: EncodeMode): DecodeResult {
  const source = mode === 'form' ? text.replaceAll('+', ' ') : text;
  const hex = (at: number): boolean => /^[0-9a-fA-F]{2}$/.test(source.slice(at + 1, at + 3));
  let out = '';
  let at = 0;
  while (at < source.length) {
    if (source[at] !== '%') {
      out += source.charAt(at);
      at += 1;
      continue;
    }
    let end = at;
    while (source[end] === '%' && hex(end)) {
      end += 3;
    }
    if (end === at) {
      return { ok: false, error: 'malformed', index: at };
    }
    try {
      out +=
        mode === 'uri'
          ? decodeURI(source.slice(at, end))
          : decodeURIComponent(source.slice(at, end));
    } catch {
      return { ok: false, error: 'malformed', index: at };
    }
    at = end;
  }
  return { ok: true, text: out };
}

describe('decodeText', () => {
  it('reads an escape at the very end, in the middle and at the start', () => {
    expect(decodeText('%41', 'component')).toEqual({ ok: true, text: 'A' });
    expect(decodeText('a%41b', 'component')).toEqual({ ok: true, text: 'aAb' });
    expect(decodeText('%41%42%43', 'component')).toEqual({ ok: true, text: 'ABC' });
    expect(decodeText('%e4%bd%a0', 'component')).toEqual({ ok: true, text: '你' });
    expect(decodeText('', 'component')).toEqual({ ok: true, text: '' });
    expect(decodeText('plain', 'component')).toEqual({ ok: true, text: 'plain' });
  });

  it('says where a % without two hex digits starts', () => {
    for (const [text, index] of [
      ['%', 0],
      ['%4', 0],
      ['%zz', 0],
      ['a%', 1],
      ['a%4', 1],
      ['%41%', 3],
      ['%41%4', 3],
      ['%41%g1', 3],
      ['ab%41cd%', 7],
    ] as const) {
      expect(decodeText(text, 'component'), text).toEqual({ ok: false, error: 'malformed', index });
    }
  });

  it('says where a run that is not UTF-8 starts', () => {
    expect(decodeText('%C3', 'component')).toEqual({ ok: false, error: 'malformed', index: 0 });
    expect(decodeText('ab%C3%28', 'component')).toEqual({
      ok: false,
      error: 'malformed',
      index: 2,
    });
    expect(decodeText('%41%C3abc', 'component')).toEqual({
      ok: false,
      error: 'malformed',
      index: 0,
    });
    // Plain text that looks like hex digits does not join two runs: the second one starts at its own %.
    expect(decodeText('%41abc%e4', 'component')).toEqual({
      ok: false,
      error: 'malformed',
      index: 6,
    });
    expect(decodeText('%41ab%e4', 'component')).toEqual({
      ok: false,
      error: 'malformed',
      index: 5,
    });
    expect(decodeText('%C3%A4%80', 'component')).toEqual({
      ok: false,
      error: 'malformed',
      index: 0,
    });
  });

  it('leaves escapes of reserved characters alone in uri mode and reads + as a space in form mode', () => {
    expect(decodeText('a%2Fb%41', 'uri')).toEqual({ ok: true, text: 'a%2FbA' });
    expect(decodeText('a+b%2B', 'form')).toEqual({ ok: true, text: 'a b+' });
    expect(decodeText('a+b', 'component')).toEqual({ ok: true, text: 'a+b' });
  });

  it('agrees with a plain character-by-character reader for any mix of escapes and text', () => {
    const pieces = [
      '%41',
      '%e4',
      '%C3%A4',
      '%zz',
      '%',
      '%4',
      'a',
      '12',
      'abc',
      '+',
      'é',
      '/',
      '%2F',
      '%80',
      '%F0%9F%98%80',
      ' ',
      'ff',
    ];
    let state = 99;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 2 ** 32;
    };
    for (let round = 0; round < 4000; round += 1) {
      const count = Math.floor(next() * 7);
      let text = '';
      for (let piece = 0; piece < count; piece += 1) {
        text += pieces[Math.floor(next() * pieces.length)] ?? '';
      }
      for (const mode of MODES) {
        expect(decodeText(text, mode), `${JSON.stringify(text)} ${mode}`).toEqual(
          reference(text, mode),
        );
      }
    }
  });
});

describe('the lorem vocabulary', () => {
  it('is these words', () => {
    expect(LOREM_UNITS).toEqual(['words', 'sentences', 'paragraphs']);
    expect(WORDS.join(' ')).toBe(
      [
        'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut',
        'labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris',
        'nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse',
        'cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui',
        'officia deserunt mollit anim id est laborum curabitur pretium tincidunt lacus gravida orci a',
        'odio nullam varius turpis pharetra eros bibendum nunc vehicula integer vitae justo',
        'eget fermentum iaculis vestibulum ante primis faucibus luctus ultrices posuere cubilia curae',
        'donec pellentesque habitant morbi tristique senectus netus malesuada fames ac egestas',
        'suspendisse potenti maecenas sollicitudin mauris tellus feugiat porta aenean euismod',
        'elementum nisl facilisis sagittis',
      ].join(' '),
    );
    expect(new Set(WORDS).size).toBe(WORDS.length);
  });
});

describe('lorem with a fixed source of numbers', () => {
  const first = (): number => 0;
  const last = (limit: number): number => limit - 1;
  const text = (
    unit: 'words' | 'sentences' | 'paragraphs',
    count: number,
    below: (limit: number) => number,
    opening = false,
  ): string => {
    const result = generateLorem({ unit, count, classicOpening: opening }, below);
    if (!result.ok) {
      throw new Error('count');
    }
    return result.text;
  };

  it('never repeats a word: the next word of the list takes its place, also after the last one', () => {
    expect(text('words', 4, first)).toBe('lorem ipsum lorem ipsum');
    const lastWord = WORDS.at(-1) ?? '';
    expect(text('words', 4, last)).toBe(`${lastWord} lorem ${lastWord} lorem`);
  });

  it('starts a sentence with a capital letter', () => {
    expect(text('sentences', 1, first)).toMatch(/^Lorem /);
    expect(text('sentences', 1, first)).toBe('Lorem ipsum lorem ipsum lorem ipsum.');
  });

  it('asks for a sentence length of 6 to 16 and a paragraph of 3 to 7 sentences', () => {
    const limits: number[] = [];
    generateLorem({ unit: 'sentences', count: 1, classicOpening: false }, (limit) => {
      limits.push(limit);
      return 0;
    });
    expect(limits[0]).toBe(11);
    const paragraphLimits: number[] = [];
    generateLorem({ unit: 'paragraphs', count: 1, classicOpening: false }, (limit) => {
      paragraphLimits.push(limit);
      return 0;
    });
    expect(paragraphLimits[0]).toBe(5);
  });

  it('puts a comma into a sentence of 8 words or more when the coin says so, never into a shorter one', () => {
    expect(drawSentence(0, first)).toBe('.');
    expect(drawSentence(1, first)).toBe('Lorem.');
    expect(drawSentence(7, first)).toBe('Lorem ipsum lorem ipsum lorem ipsum lorem.');
    expect(drawSentence(8, first)).toBe('Lorem ipsum lorem, ipsum lorem ipsum lorem ipsum.');
    expect(drawSentence(9, first)).toBe('Lorem ipsum lorem, ipsum lorem ipsum lorem ipsum lorem.');
    // The coin says no: it is the draw with the limit 2.
    const noComma = (limit: number): number => (limit === 2 ? 1 : 0);
    expect(drawSentence(8, noComma)).toBe('Lorem ipsum lorem ipsum lorem ipsum lorem ipsum.');
    expect(drawSentence(16, noComma).includes(',')).toBe(false);
  });

  it('puts the comma after a word that leaves two words on each side', () => {
    const farthest = (limit: number): number => (limit === 2 ? 0 : limit === 12 ? 11 : 0);
    // 16 words: the comma goes after the word at index 2 + (12 - 1) = 13.
    const sentence = drawSentence(16, farthest);
    expect(sentence.split(' ').findIndex((word) => word.endsWith(','))).toBe(13);
  });

  it('takes as many drawn words after the opening as the count asks for', () => {
    expect(text('words', 3, first, true)).toBe('lorem ipsum dolor');
    expect(text('words', 8, first, true)).toBe(
      'lorem ipsum dolor sit amet consectetur adipiscing elit',
    );
    expect(text('words', 10, first, true)).toBe(
      'lorem ipsum dolor sit amet consectetur adipiscing elit lorem ipsum',
    );
    expect(text('words', 1, first, true)).toBe('lorem');
  });

  it('does not repeat the last word of the opening in the first word drawn after it', () => {
    const elit = WORDS.indexOf('elit');
    const draws = [elit, 0];
    let at = 0;
    const below = (): number => draws[at++] ?? 0;
    expect(text('words', 9, below, true)).toBe(
      'lorem ipsum dolor sit amet consectetur adipiscing elit sed',
    );
  });

  it('opens the first sentence and the first paragraph with the classic line only', () => {
    expect(text('sentences', 2, first, true).startsWith(`${CLASSIC_OPENING} `)).toBe(true);
    const paragraphs = text('paragraphs', 2, first, true).split('\n\n');
    expect(paragraphs[0]?.startsWith(CLASSIC_OPENING)).toBe(true);
    expect(paragraphs[1]?.startsWith(CLASSIC_OPENING)).toBe(false);
  });
});
