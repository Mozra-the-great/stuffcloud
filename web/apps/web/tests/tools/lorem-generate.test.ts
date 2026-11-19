import { describe, expect, it } from 'vitest';
import {
  CLASSIC_OPENING,
  DEFAULT_COUNT,
  LIMITS,
  LOREM_UNITS,
  PARAGRAPH_SENTENCES,
  SENTENCE_WORDS,
  WORDS,
  drawSentence,
  generateLorem,
  type Below,
} from '../../src/tools/lorem/generate.ts';
import { randomBelow } from '../../src/tools/password/generate.ts';

/** A small seeded generator (mulberry32), so every run draws the same text. */
function seeded(seed: number): Below {
  let state = seed;
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * limit);
  };
}

function text(unit: 'words' | 'sentences' | 'paragraphs', count: number, opening = false): string {
  const result = generateLorem({ unit, count, classicOpening: opening }, seeded(7));
  if (!result.ok) {
    throw new Error('expected a text');
  }
  return result.text;
}

function sentencesOf(paragraph: string): string[] {
  return paragraph
    .split('. ')
    .map((part, index, all) => (index < all.length - 1 ? `${part}.` : part));
}

describe('the vocabulary', () => {
  it('has no word twice and only lowercase letters', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length);
    for (const word of WORDS) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it('contains the words of the classic opening', () => {
    for (const word of CLASSIC_OPENING.replace(/[,.]/g, '').toLowerCase().split(' ')) {
      expect(WORDS).toContain(word);
    }
  });
});

describe('words', () => {
  it.each([1, 2, 7, 50, 5000])('makes exactly %i words', (count) => {
    expect(text('words', count).split(' ')).toHaveLength(count);
  });

  it('is lowercase without punctuation and never repeats a word in a row', () => {
    const words = text('words', 2000).split(' ');
    for (const [index, word] of words.entries()) {
      expect(word).toMatch(/^[a-z]+$/);
      expect(word).not.toBe(words[index - 1]);
    }
  });

  it('starts with the classic opening on request, and cuts it when fewer words are wanted', () => {
    expect(
      text('words', 20, true).startsWith('lorem ipsum dolor sit amet consectetur adipiscing elit '),
    ).toBe(true);
    expect(text('words', 3, true)).toBe('lorem ipsum dolor');
    expect(text('words', 7, true)).toBe('lorem ipsum dolor sit amet consectetur adipiscing');
    expect(text('words', 20).startsWith('lorem ipsum')).toBe(false);
  });

  it('draws the words after the opening from the list', () => {
    const words = text('words', 9, true).split(' ');
    expect(words).toHaveLength(9);
    expect(words[7]).toBe('elit');
    expect(WORDS).toContain(words[8]);
    expect(words[8]).not.toBe('elit');
  });
});

describe('sentences', () => {
  it('makes exactly the number of sentences, each capitalised and ended by a full stop', () => {
    const made = text('sentences', 40);
    const parts = sentencesOf(made);
    expect(parts).toHaveLength(40);
    for (const sentence of parts) {
      expect(sentence).toMatch(/^[A-Z][a-z]*( [a-z]+,?)*\.$/);
      const words = sentence.split(' ').length;
      expect(words).toBeGreaterThanOrEqual(SENTENCE_WORDS.min);
      expect(words).toBeLessThanOrEqual(SENTENCE_WORDS.max);
    }
  });

  it('puts the opening first on request and only first', () => {
    const made = text('sentences', 3, true);
    expect(made.startsWith(`${CLASSIC_OPENING} `)).toBe(true);
    expect(made.slice(CLASSIC_OPENING.length).includes(CLASSIC_OPENING)).toBe(false);
    expect(text('sentences', 1, true)).toBe(CLASSIC_OPENING);
  });

  it('has at most one comma, never near the ends, and only in a long sentence', () => {
    const long = Array.from({ length: 300 }, (_, seed) => drawSentence(12, seeded(seed)));
    for (const sentence of long) {
      const words = sentence.split(' ');
      expect(sentence.split(',').length - 1).toBeLessThanOrEqual(1);
      for (const index of [0, 1, words.length - 2, words.length - 1]) {
        expect(words[index]).not.toContain(',');
      }
    }
    expect(long.some((sentence) => sentence.includes(','))).toBe(true);
    expect(long.some((sentence) => !sentence.includes(','))).toBe(true);
    for (let seed = 0; seed < 100; seed += 1) {
      expect(drawSentence(7, seeded(seed))).not.toContain(',');
    }
  });

  it('draws a sentence of the shortest and of the longest length', () => {
    expect(drawSentence(SENTENCE_WORDS.min, seeded(1)).split(' ')).toHaveLength(SENTENCE_WORDS.min);
    expect(drawSentence(SENTENCE_WORDS.max, seeded(1)).split(' ')).toHaveLength(SENTENCE_WORDS.max);
  });
});

describe('paragraphs', () => {
  it('makes the number of paragraphs, separated by one blank line, of 3 to 7 sentences', () => {
    const made = text('paragraphs', 25);
    const parts = made.split('\n\n');
    expect(parts).toHaveLength(25);
    for (const paragraph of parts) {
      const count = sentencesOf(paragraph).length;
      expect(count).toBeGreaterThanOrEqual(PARAGRAPH_SENTENCES.min);
      expect(count).toBeLessThanOrEqual(PARAGRAPH_SENTENCES.max);
    }
    expect(made.endsWith('\n')).toBe(false);
  });

  it('starts only the first paragraph with the opening', () => {
    const parts = text('paragraphs', 3, true).split('\n\n');
    expect(parts[0]?.startsWith(CLASSIC_OPENING)).toBe(true);
    expect(parts[1]?.startsWith(CLASSIC_OPENING)).toBe(false);
  });
});

describe('the limits', () => {
  it.each(LOREM_UNITS)('refuses 0, a negative, a fraction, NaN and too many %s', (unit) => {
    const max = LIMITS[unit];
    for (const count of [0, -1, 1.5, Number.NaN, max + 1]) {
      expect(generateLorem({ unit, count, classicOpening: true })).toEqual({
        ok: false,
        error: { code: 'count', min: 1, max },
      });
    }
    expect(generateLorem({ unit, count: max, classicOpening: false }).ok).toBe(true);
    expect(generateLorem({ unit, count: 1, classicOpening: false }).ok).toBe(true);
  });

  it('has defaults inside the limits', () => {
    for (const unit of LOREM_UNITS) {
      expect(DEFAULT_COUNT[unit]).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_COUNT[unit]).toBeLessThanOrEqual(LIMITS[unit]);
    }
  });
});

describe('randomness', () => {
  it('is reproducible for the same numbers and different for other numbers', () => {
    expect(text('paragraphs', 4)).toBe(text('paragraphs', 4));
    const other = generateLorem({ unit: 'paragraphs', count: 4, classicOpening: false }, seeded(8));
    expect(other.ok && other.text).not.toBe(text('paragraphs', 4));
  });

  it('survives a generator that always returns the same number (no endless loop)', () => {
    const first = generateLorem({ unit: 'words', count: 10, classicOpening: false }, () => 0);
    expect(first.ok && first.text.split(' ')).toHaveLength(10);
    const last = generateLorem(
      { unit: 'words', count: 4, classicOpening: false },
      (limit) => limit - 1,
    );
    expect(last.ok && last.text.split(' ')).toHaveLength(4);
  });

  it('uses the secure generator by default and differs between calls', () => {
    const first = generateLorem({ unit: 'words', count: 200, classicOpening: false });
    const second = generateLorem({ unit: 'words', count: 200, classicOpening: false });
    expect(first.ok && second.ok && first.text !== second.text).toBe(true);
    expect(randomBelow(WORDS.length)).toBeLessThan(WORDS.length);
  });

  it('uses every word of the vocabulary over a long text', () => {
    const made = generateLorem({ unit: 'words', count: 5000, classicOpening: false });
    expect(new Set(made.ok ? made.text.split(' ') : []).size).toBe(WORDS.length);
  });
});
