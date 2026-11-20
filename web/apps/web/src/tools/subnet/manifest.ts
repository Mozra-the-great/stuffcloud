import { defineTool } from '../define.ts';

export default defineTool({
  id: 'subnet',
  category: 'network',
  nameKey: 'tool.subnet.name',
  descriptionKey: 'tool.subnet.description',
  keywordsKey: 'tool.subnet.keywords',
  sticker: 'subnet',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
