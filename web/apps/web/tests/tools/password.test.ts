import { describe, expect, it } from 'vitest';
import manifest from '../../src/tools/password/manifest.ts';
import { openTool } from '../tool-helpers.ts';

describe('password', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/password with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/password');
    expect(view.headings).toEqual(['Password generator']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search and listed with its category', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('password generator')).toEqual(['password']);
  });
});
