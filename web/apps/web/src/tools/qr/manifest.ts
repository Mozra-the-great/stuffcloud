import { defineTool } from '../define.ts';

export default defineTool({
  id: 'qr',
  category: 'text',
  nameKey: 'tool.qr.name',
  descriptionKey: 'tool.qr.description',
  keywordsKey: 'tool.qr.keywords',
  sticker: 'qr',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 160, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
