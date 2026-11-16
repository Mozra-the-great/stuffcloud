import { describe, expect, it } from 'vitest';
import { nextTabIndex } from '../src/ui/tabs-nav.ts';

describe('nextTabIndex', () => {
  it('ArrowRight moves on and wraps from the last tab to the first', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 1, 3)).toBe(2);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
  });

  it('ArrowLeft moves back and wraps from the first tab to the last', () => {
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1);
    expect(nextTabIndex('ArrowLeft', 1, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
  });

  it('Home and End jump to the ends from anywhere', () => {
    for (const index of [0, 1, 2]) {
      expect(nextTabIndex('Home', index, 3)).toBe(0);
      expect(nextTabIndex('End', index, 3)).toBe(2);
    }
  });

  it('a single tab stays put', () => {
    expect(nextTabIndex('ArrowRight', 0, 1)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 1)).toBe(0);
    expect(nextTabIndex('End', 0, 1)).toBe(0);
  });

  it('ignores every other key, including look-alikes', () => {
    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'Tab',
      'Enter',
      ' ',
      'a',
      'home',
      'arrowright',
      '',
    ]) {
      expect(nextTabIndex(key, 1, 3)).toBeUndefined();
    }
  });
});
