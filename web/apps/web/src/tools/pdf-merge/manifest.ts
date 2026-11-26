import { defineTool } from '../define.ts';

export default defineTool({
  id: 'pdf-merge',
  category: 'pdf',
  nameKey: 'tool.pdf-merge.name',
  descriptionKey: 'tool.pdf-merge.description',
  keywordsKey: 'tool.pdf-merge.keywords',
  sticker: 'pdf-merge',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 15, assetsKb: 800 },
  load: () => import('./Tool.svelte'),
});
