import { defineTool } from '@stuffcloud/tools';
import type { RouteModule } from '../../../../src/app/router/router.svelte.ts';

/** Test-only tool: hashes files in a pool of workers, so the pool runs in a real browser. */
export default defineTool<string, RouteModule>({
  id: 'worker-lab',
  category: 'extra',
  nameKey: 'tool.worker-lab.name',
  descriptionKey: 'tool.worker-lab.description',
  keywordsKey: 'tool.worker-lab.keywords',
  sticker: 'hash',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker', 'webcrypto'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
