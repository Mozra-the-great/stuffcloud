import { defineTool } from '../define.ts';

export default defineTool({
  id: 'markdown',
  category: 'extra',
  nameKey: 'tool.markdown.name',
  descriptionKey: 'tool.markdown.description',
  keywordsKey: 'tool.markdown.keywords',
  sticker: 'markdown',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 43, assetsKb: 18 },
  load: () => import('./Tool.svelte'),
});
