import { describe, expect, it } from 'vitest';
import { parseToolSet, TOOL_CATEGORIES } from '../src/index.ts';
import { mutate } from './fixtures.ts';

function ids(inputs: readonly Record<string, unknown>[]): readonly string[] {
  const result = parseToolSet(inputs, TOOL_CATEGORIES);
  if (!result.ok) {
    throw new Error('the set is valid');
  }
  return result.manifests.map((manifest) => manifest.id);
}

function tool(id: string): Record<string, unknown> {
  return mutate({ id }, id);
}

/** Every order of `items`, so a comparator that is right for some pairs only cannot pass. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe('parseToolSet: the order within a category', () => {
  it('is by id for every arrangement of the input', () => {
    for (const order of permutations(['alpha', 'beta', 'gamma', 'delta'])) {
      expect(ids(order.map(tool))).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    }
  });

  it('compares ids as text: a hyphen and a digit sort by their code points', () => {
    expect(ids(['a-b', 'a1', 'a', 'ab'].map(tool))).toEqual(['a', 'a-b', 'a1', 'ab']);
  });

  it('keeps categories in the order given, then ids', () => {
    const inputs = [
      mutate({ id: 'z-pdf', category: 'pdf' }, 'z-pdf'),
      mutate({ id: 'a-img', category: 'image' }, 'a-img'),
      mutate({ id: 'a-pdf', category: 'pdf' }, 'a-pdf'),
    ];
    const reversed = [...TOOL_CATEGORIES].reverse();
    const result = parseToolSet(inputs, reversed);
    expect(result.ok && result.manifests.map((manifest) => manifest.id)).toEqual(
      reversed.indexOf('pdf') < reversed.indexOf('image')
        ? ['a-pdf', 'z-pdf', 'a-img']
        : ['a-img', 'a-pdf', 'z-pdf'],
    );
  });
});
