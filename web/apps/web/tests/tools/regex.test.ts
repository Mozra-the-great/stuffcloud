import { describe, expect, it } from 'vitest';
import manifest from '../../src/tools/regex/manifest.ts';
import { openTool } from '../tool-helpers.ts';

describe('regex', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/regex with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/regex');
    expect(view.headings).toEqual(['Regex tester']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search and listed with its category', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('regex tester')).toEqual(['regex']);
  });
});
