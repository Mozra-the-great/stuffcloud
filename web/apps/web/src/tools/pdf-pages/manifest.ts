import { defineTool } from '../define.ts';

export default defineTool({
  id: 'pdf-pages',
  category: 'pdf',
  nameKey: 'tool.pdf-pages.name',
  descriptionKey: 'tool.pdf-pages.description',
  keywordsKey: 'tool.pdf-pages.keywords',
  sticker: 'pdf-rotate',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 20, assetsKb: 800 },
  load: () => import('./Tool.svelte'),
});
