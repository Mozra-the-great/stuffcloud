import { defineTool } from '../define.ts';

export default defineTool({
  id: 'lorem',
  category: 'text',
  nameKey: 'tool.lorem.name',
  descriptionKey: 'tool.lorem.description',
  keywordsKey: 'tool.lorem.keywords',
  sticker: 'lorem',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
