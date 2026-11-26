import { defineTool } from '../define.ts';

export default defineTool({
  id: 'cron',
  category: 'parse',
  nameKey: 'tool.cron.name',
  descriptionKey: 'tool.cron.description',
  keywordsKey: 'tool.cron.keywords',
  sticker: 'cron',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 19, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
