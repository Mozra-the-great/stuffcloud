import toolsConfig from '../../tools.config.json';
import { buildRegistry, type ManifestModules } from './registry.ts';

/**
 * Every `src/tools/<id>/manifest.ts` (eager: the manifests are small data, the tools themselves
 * load lazily through `load()`). Adding a tool is adding that directory; nothing else lists it.
 */
const MANIFESTS: ManifestModules = import.meta.glob<{ default?: unknown }>(
  '../tools/*/manifest.ts',
  { eager: true },
);

/**
 * The tools this build ships, built from the manifests and `tools.config.json`: navigation,
 * search and routes all read this list. A broken manifest throws here, so the app does not start
 * (and `vite build` already failed on it, see `scripts/check-tools.ts`).
 */
export const TOOL_ENTRIES = buildRegistry(MANIFESTS, { config: toolsConfig }).entries;
