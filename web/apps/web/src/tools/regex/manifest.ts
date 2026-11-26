import { defineTool } from '../define.ts';

export default defineTool({
  id: 'regex',
  category: 'extra',
  nameKey: 'tool.regex.name',
  descriptionKey: 'tool.regex.description',
  keywordsKey: 'tool.regex.keywords',
  sticker: 'regex',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 15, assetsKb: 2 },
  load: () => import('./Tool.svelte'),
});
