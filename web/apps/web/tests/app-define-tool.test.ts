import { ManifestError } from '@stuffcloud/tools';
import { describe, expect, it } from 'vitest';
import type { RouteModule } from '../src/app/router/router.svelte.ts';
import type { MessageKey } from '../src/i18n/index.ts';
import { defineTool } from '../src/tools/define.ts';

const page = (): Promise<RouteModule> => import('./ToolPage.svelte');

/** The schema wants `tool.<id>.<text>`; a real tool has those keys in the catalogue. */
const key = (text: string): MessageKey => text as MessageKey;

describe('defineTool of the app', () => {
  it('returns the checked manifest', () => {
    const manifest = defineTool({
      id: 'qr',
      category: 'text',
      nameKey: key('tool.qr.name'),
      descriptionKey: key('tool.qr.description'),
      keywordsKey: key('tool.qr.keywords'),
      sticker: 'qr',
      runsIn: 'client',
      fileContent: 'stays-in-browser',
      requires: [],
      budget: { scriptKb: 1, assetsKb: 0 },
      load: page,
    });
    expect(manifest.id).toBe('qr');
    expect(manifest.nameKey).toBe('tool.qr.name');
  });

  it('throws the schema error for a manifest that breaks a rule', () => {
    expect(() =>
      defineTool({
        id: 'qr',
        category: 'text',
        nameKey: 'tool.localOnly',
        descriptionKey: key('tool.qr.description'),
        keywordsKey: key('tool.qr.keywords'),
        sticker: 'qr',
        runsIn: 'client',
        fileContent: 'stays-in-browser',
        requires: [],
        budget: { scriptKb: 1, assetsKb: 0 },
        load: page,
      }),
    ).toThrow(ManifestError);
  });

  it('does not compile with a message key the catalogue lacks', () => {
    const attempt = (): unknown =>
      defineTool({
        id: 'qr',
        category: 'text',
        // @ts-expect-error -- 'tool.qr.name' is not a message of the catalogue
        nameKey: 'tool.qr.name',
        descriptionKey: key('tool.qr.description'),
        keywordsKey: key('tool.qr.keywords'),
        sticker: 'qr',
        runsIn: 'client',
        fileContent: 'stays-in-browser',
        requires: [],
        budget: { scriptKb: 1, assetsKb: 0 },
        load: page,
      });
    // At run time the key follows the convention, so the schema passes; whether the text exists
    // is the registry's check (tool-registry.test.ts).
    expect(attempt).not.toThrow();
  });
});
