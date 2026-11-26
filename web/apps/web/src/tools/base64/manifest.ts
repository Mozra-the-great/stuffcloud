import { defineTool } from '../define.ts';

export default defineTool({
  id: 'base64',
  category: 'convert',
  nameKey: 'tool.base64.name',
  descriptionKey: 'tool.base64.description',
  keywordsKey: 'tool.base64.keywords',
  sticker: 'base64',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 33, assetsKb: 3 },
  load: () => import('./Tool.svelte'),
});
