import { defineTool } from '../define.ts';

export default defineTool({
  id: 'hash',
  category: 'extra',
  nameKey: 'tool.hash.name',
  descriptionKey: 'tool.hash.description',
  keywordsKey: 'tool.hash.keywords',
  sticker: 'hash',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['webcrypto', 'worker'],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
