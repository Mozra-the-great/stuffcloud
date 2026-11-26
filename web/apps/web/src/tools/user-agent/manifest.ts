import { defineTool } from '../define.ts';

export default defineTool({
  id: 'user-agent',
  category: 'parse',
  nameKey: 'tool.user-agent.name',
  descriptionKey: 'tool.user-agent.description',
  keywordsKey: 'tool.user-agent.keywords',
  sticker: 'useragent',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 13, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
