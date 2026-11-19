import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STICKER_NAMES } from '../src/index.ts';

const prototypes = resolve(import.meta.dirname, '../../../../docs/design/prototypes');

describe('STICKER_NAMES', () => {
  it('is exactly the set of stickers in docs/design/prototypes (both directions)', () => {
    const files = readdirSync(prototypes)
      .filter((name) => /^sticker-.+\.svg$/.test(name))
      .map((name) => name.slice('sticker-'.length, -'.svg'.length))
      .toSorted();
    expect([...STICKER_NAMES].toSorted()).toEqual(files);
  });
});
