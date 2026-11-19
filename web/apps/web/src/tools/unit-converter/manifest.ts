import { defineTool } from '../define.ts';

export default defineTool({
  id: 'unit-converter',
  category: 'convert',
  nameKey: 'tool.unit-converter.name',
  descriptionKey: 'tool.unit-converter.description',
  keywordsKey: 'tool.unit-converter.keywords',
  sticker: 'units',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: [],
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
