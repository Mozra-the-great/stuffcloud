import { defineTool } from '../define.ts';

export default defineTool({
  id: 'pdf-split',
  category: 'pdf',
  nameKey: 'tool.pdf-split.name',
  descriptionKey: 'tool.pdf-split.description',
  keywordsKey: 'tool.pdf-split.keywords',
  sticker: 'pdf-split',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 460, assetsKb: 1800 },
  load: () => import('./Tool.svelte'),
});
