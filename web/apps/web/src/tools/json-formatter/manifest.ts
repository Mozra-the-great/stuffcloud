import { defineTool } from '../define.ts';

export default defineTool({
  id: 'json-formatter',
  category: 'extra',
  nameKey: 'tool.json-formatter.name',
  descriptionKey: 'tool.json-formatter.description',
  keywordsKey: 'tool.json-formatter.keywords',
  sticker: 'json',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 24, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
