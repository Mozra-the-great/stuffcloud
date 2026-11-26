import { defineTool } from '../define.ts';

export default defineTool({
  id: 'sql-formatter',
  category: 'extra',
  nameKey: 'tool.sql-formatter.name',
  descriptionKey: 'tool.sql-formatter.description',
  keywordsKey: 'tool.sql-formatter.keywords',
  sticker: 'sql',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 21, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
