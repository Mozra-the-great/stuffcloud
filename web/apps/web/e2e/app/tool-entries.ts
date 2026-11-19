import toolsConfig from '../../tools.config.json';
import { buildRegistry, type ManifestModules } from '../../src/app/registry.ts';
import * as sampleTool from '../../tests/fixtures/sample-tool/manifest.ts';
import { E2E_CATALOGS } from './messages.ts';

/**
 * Replaces `src/app/tool-entries.ts` in the end-to-end build (see `e2e/vite.config.ts`): the tools
 * the app ships (`src/tools`), the sample tool of the registry tests and the test-only tools of
 * `e2e/app/tools`, all checked by the same registry.
 */
const SHIPPED: ManifestModules = import.meta.glob<{ default?: unknown }>(
  '../../src/tools/*/manifest.ts',
  { eager: true },
);
const TEST_ONLY: ManifestModules = import.meta.glob<{ default?: unknown }>(
  './tools/*/manifest.ts',
  { eager: true },
);

export const TOOL_ENTRIES = buildRegistry(
  {
    ...SHIPPED,
    ...TEST_ONLY,
    '../../tests/fixtures/sample-tool/manifest.ts': sampleTool,
  },
  { catalogs: E2E_CATALOGS, config: toolsConfig },
).entries;
