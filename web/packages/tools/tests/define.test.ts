import { describe, expect, it } from 'vitest';
import { defineTool, formatIssues, ManifestError } from '../src/index.ts';
import { mutate, validInput } from './fixtures.ts';

describe('defineTool', () => {
  it('returns the checked manifest', () => {
    const manifest = defineTool(validInput());
    expect(manifest.id).toBe('pdf-merge');
    expect(manifest.requires).toEqual(['worker', 'wasm']);
  });

  it('throws a ManifestError that lists every violated rule', () => {
    let caught: unknown;
    try {
      defineTool(mutate({ category: 'nope', sticker: 'nope' }) as never);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestError);
    const error = caught as ManifestError;
    expect(error.name).toBe('ManifestError');
    expect(error.issues.map((issue) => issue.code)).toEqual([
      'invalid-category',
      'invalid-sticker',
    ]);
    expect(error.message).toContain('tool manifest "pdf-merge" is invalid:');
    expect(error.message).toContain('  - category: "nope" is not a category');
    expect(error.message).toContain('  - sticker: "nope" is not a design sticker');
  });

  it('names the manifest with "?" when the id is not even a string', () => {
    expect(() => defineTool(mutate({ id: 1 }) as never)).toThrow('tool manifest "?" is invalid');
  });

  it('passes the options on', () => {
    const server = mutate({ runsIn: 'server' }) as never;
    expect(() => defineTool(server)).toThrow(ManifestError);
    expect(defineTool(server, { allowServer: true }).runsIn).toBe('server');
  });
});

describe('formatIssues', () => {
  it('prefixes the path and leaves out an empty one', () => {
    expect(
      formatIssues([
        { path: 'a.b', code: 'invalid-id', message: 'is wrong' },
        { path: '', code: 'not-an-object', message: 'a manifest must be an object' },
      ]),
    ).toBe('  - a.b: is wrong\n  - a manifest must be an object');
  });
});
