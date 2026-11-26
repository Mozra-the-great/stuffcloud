import { defineTool } from '../define.ts';

export default defineTool({
  id: 'timestamp',
  category: 'extra',
  nameKey: 'tool.timestamp.name',
  descriptionKey: 'tool.timestamp.description',
  keywordsKey: 'tool.timestamp.keywords',
  sticker: 'timestamp',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 14, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
