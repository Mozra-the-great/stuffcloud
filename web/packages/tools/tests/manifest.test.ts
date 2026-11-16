import { describe, expect, it } from 'vitest';
import { defineTool } from '../src/index.ts';

describe('defineTool', () => {
  it('returns a manifest carrying the parsed id', () => {
    expect(defineTool('pdf-merge')).toEqual({ id: 'pdf-merge' });
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(49), 'too-long'],
    ['Not Valid', 'invalid-characters'],
  ])('throws a RangeError naming the rule for %j', (id, rule) => {
    expect(() => defineTool(id)).toThrow(RangeError);
    expect(() => defineTool(id)).toThrow(`invalid tool id ${JSON.stringify(id)}: ${rule}`);
  });
});
