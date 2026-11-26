import { defineTool } from '../define.ts';

export default defineTool({
  id: 'json-yaml-xml',
  category: 'convert',
  nameKey: 'tool.json-yaml-xml.name',
  descriptionKey: 'tool.json-yaml-xml.description',
  keywordsKey: 'tool.json-yaml-xml.keywords',
  sticker: 'yaml',
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ['worker'],
  budget: { scriptKb: 39, assetsKb: 43 },
  load: () => import('./Tool.svelte'),
});
