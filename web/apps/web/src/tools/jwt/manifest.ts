import { defineTool } from '../define.ts';

export default defineTool({
  id: 'jwt',
  category: 'extra',
  nameKey: 'tool.jwt.name',
  descriptionKey: 'tool.jwt.description',
  keywordsKey: 'tool.jwt.keywords',
  sticker: 'jwt',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['webcrypto'],
  budget: { scriptKb: 16, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
