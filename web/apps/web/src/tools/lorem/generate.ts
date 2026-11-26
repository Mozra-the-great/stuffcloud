/**
 * Lorem ipsum: placeholder text from a fixed vocabulary of Latin-looking words. The words are drawn
 * with the browser's secure random number generator (`randomBelow`); a test passes its own `below`
 * to get a fixed text.
 */

import { randomBelow } from '../password/generate.ts';

export type LoremUnit = 'words' | 'sentences' | 'paragraphs';

export const LOREM_UNITS: readonly LoremUnit[] = ['words', 'sentences', 'paragraphs'];

/** The most a visitor can ask for per unit (a page of text, not a memory test). */
export const LIMITS: Readonly<Record<LoremUnit, number>> = {
  words: 5000,
  sentences: 1000,
  paragraphs: 200,
};

export const DEFAULT_COUNT: Readonly<Record<LoremUnit, number>> = {
  words: 50,
  sentences: 5,
  paragraphs: 3,
};

/** The opening every generator knows. */
export const CLASSIC_OPENING = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';

const OPENING_WORDS = CLASSIC_OPENING.replace(/[,.]/g, '').toLowerCase().split(' ');

/** About 190 words of the traditional vocabulary (the text of Cicero's "de Finibus" and its descendants). */
export const WORDS: readonly string[] = [
  ...(
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
    'labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris ' +
    'nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse ' +
    'cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui ' +
    'officia deserunt mollit anim id est laborum curabitur pretium tincidunt lacus gravida orci a ' +
    'odio nullam varius turpis pharetra eros bibendum nunc vehicula integer vitae justo ' +
    'eget fermentum iaculis vestibulum ante primis faucibus luctus ultrices posuere cubilia curae ' +
    'donec pellentesque habitant morbi tristique senectus netus malesuada fames ac egestas ' +
    'suspendisse potenti maecenas sollicitudin mauris tellus feugiat porta aenean euismod ' +
    'elementum nisl facilisis sagittis'
  ).split(' '),
];

/** Words in a generated sentence, from and up to (inclusive). */
export const SENTENCE_WORDS = { min: 6, max: 16 } as const;
/** Sentences in a generated paragraph, from and up to (inclusive). */
export const PARAGRAPH_SENTENCES = { min: 3, max: 7 } as const;

export interface LoremOptions {
  readonly unit: LoremUnit;
  readonly count: number;
  /** Start with "Lorem ipsum dolor sit amet, consectetur adipiscing elit." */
  readonly classicOpening: boolean;
}

export interface LoremError {
  readonly code: 'count';
  readonly min: 1;
  readonly max: number;
}

export type LoremResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: LoremError };

/** A uniform whole number from 0 up to, not including, `limit`. */
export type Below = (limit: number) => number;

function between(range: { readonly min: number; readonly max: number }, below: Below): number {
  return range.min + below(range.max - range.min + 1);
}

/** `count` words in a row; the same word never comes twice in a row. */
function drawWords(count: number, below: Below, previous: string | undefined): string[] {
  const words: string[] = [];
  let last = previous;
  for (let index = 0; index < count; index += 1) {
    const at = below(WORDS.length);
    // Stryker disable next-line StringLiteral: `below(limit)` is below `limit`, so the word exists and the fallback is never used
    let word = WORDS[at] ?? '';
    if (word === last) {
      // The next word of the list: no second draw, so the result is the same for the same numbers.
      // Stryker disable next-line StringLiteral: as above
      word = WORDS[(at + 1) % WORDS.length] ?? '';
    }
    words.push(word);
    last = word;
  }
  return words;
}

function capitalise(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** One sentence of `length` words: capitalised, a comma in the middle of a long one, a full stop. */
export function drawSentence(length: number, below: Below): string {
  const words = drawWords(length, below, undefined);
  const first = words[0];
  if (first !== undefined) {
    words[0] = capitalise(first);
  }
  // A comma after a word that leaves at least two words on each side.
  if (length >= 8 && below(2) === 0) {
    const at = 2 + below(length - 4);
    // Stryker disable next-line StringLiteral: `at` is between 2 and `length` - 3, so the word exists
    words[at] = `${words[at] ?? ''},`;
  }
  return `${words.join(' ')}.`;
}

function sentences(count: number, below: Below, opening: boolean): string[] {
  const list: string[] = [];
  for (let index = 0; index < count; index += 1) {
    list.push(
      opening && index === 0
        ? CLASSIC_OPENING
        : drawSentence(between(SENTENCE_WORDS, below), below),
    );
  }
  return list;
}

/** Text of `count` words, all lowercase and without punctuation. */
function wordsText(count: number, below: Below, opening: boolean): string {
  const head = opening ? OPENING_WORDS.slice(0, count) : [];
  const rest = drawWords(count - head.length, below, head[head.length - 1]);
  return [...head, ...rest].join(' ');
}

function paragraphs(count: number, below: Below, opening: boolean): string {
  const list: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = between(PARAGRAPH_SENTENCES, below);
    list.push(sentences(size, below, opening && index === 0).join(' '));
  }
  return list.join('\n\n');
}

export function generateLorem(options: LoremOptions, below: Below = randomBelow): LoremResult {
  const max = LIMITS[options.unit];
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > max) {
    return { ok: false, error: { code: 'count', min: 1, max } };
  }
  const { count, classicOpening } = options;
  switch (options.unit) {
    case 'words':
      return { ok: true, text: wordsText(count, below, classicOpening) };
    case 'sentences':
      return { ok: true, text: sentences(count, below, classicOpening).join(' ') };
    case 'paragraphs':
      return { ok: true, text: paragraphs(count, below, classicOpening) };
  }
}
