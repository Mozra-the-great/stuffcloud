import { defineTool } from '../define.ts';

export default defineTool({
  id: 'uuid',
  category: 'text',
  nameKey: 'tool.uuid.name',
  descriptionKey: 'tool.uuid.description',
  keywordsKey: 'tool.uuid.keywords',
  sticker: 'uuid',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 19, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
