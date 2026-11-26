import { defineTool } from '../define.ts';

export default defineTool({
  id: 'url',
  category: 'extra',
  nameKey: 'tool.url.name',
  descriptionKey: 'tool.url.description',
  keywordsKey: 'tool.url.keywords',
  sticker: 'url',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 13, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
