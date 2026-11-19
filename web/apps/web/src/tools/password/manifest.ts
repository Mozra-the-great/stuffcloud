import { defineTool } from '../define.ts';

export default defineTool({
  id: 'password',
  category: 'extra',
  nameKey: 'tool.password.name',
  descriptionKey: 'tool.password.description',
  keywordsKey: 'tool.password.keywords',
  sticker: 'password',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['webcrypto'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
