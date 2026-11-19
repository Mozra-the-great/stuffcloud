import { defineTool } from '@stuffcloud/tools';
import type { RouteModule } from '../../../src/app/router/router.svelte.ts';

/** A tool that exists only for the tests: everything the app knows about it is this manifest. */
export default defineTool<string, RouteModule>({
  id: 'sample-tool',
  category: 'text',
  nameKey: 'tool.sample-tool.name',
  descriptionKey: 'tool.sample-tool.description',
  keywordsKey: 'tool.sample-tool.keywords',
  sticker: 'textops',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 10, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
