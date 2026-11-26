import { defineTool } from '../define.ts';

export default defineTool({
  id: 'color',
  category: 'convert',
  nameKey: 'tool.color.name',
  descriptionKey: 'tool.color.description',
  keywordsKey: 'tool.color.keywords',
  sticker: 'colour',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 20, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
