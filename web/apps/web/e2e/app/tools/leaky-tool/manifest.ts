import { defineTool } from '@stuffcloud/tools';
import type { RouteModule } from '../../../../src/app/router/router.svelte.ts';

/**
 * Test-only tool that breaks the privacy promise on purpose, four ways. The privacy test must
 * notice every one of them; without this tool nothing would show that the check can fail.
 */
export default defineTool<string, RouteModule>({
  id: 'leaky-tool',
  category: 'extra',
  nameKey: 'tool.leaky-tool.name',
  descriptionKey: 'tool.leaky-tool.description',
  keywordsKey: 'tool.leaky-tool.keywords',
  sticker: 'shield',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
