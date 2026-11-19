import { defineTool } from '../define.ts';

export default defineTool({
  id: 'textops',
  category: 'text',
  nameKey: 'tool.textops.name',
  descriptionKey: 'tool.textops.description',
  keywordsKey: 'tool.textops.keywords',
  sticker: 'textops',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
