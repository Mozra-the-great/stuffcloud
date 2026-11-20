import { defineTool } from '../define.ts';

export default defineTool({
  id: 'mac',
  category: 'network',
  nameKey: 'tool.mac.name',
  descriptionKey: 'tool.mac.description',
  keywordsKey: 'tool.mac.keywords',
  sticker: 'mac',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
