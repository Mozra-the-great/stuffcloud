import { describe, expect, it } from 'vitest';
import manifest from '../../src/tools/jwt/manifest.ts';
import { openTool } from '../tool-helpers.ts';

describe('jwt', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/jwt with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/jwt');
    expect(view.headings).toEqual(['JWT decoder']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search and listed with its category', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('jwt decoder')).toEqual(['jwt']);
  });
});
