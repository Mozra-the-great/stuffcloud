import { defineTool } from '../define.ts';

export default defineTool({
  id: 'diff',
  category: 'text',
  nameKey: 'tool.diff.name',
  descriptionKey: 'tool.diff.description',
  keywordsKey: 'tool.diff.keywords',
  sticker: 'diff',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
