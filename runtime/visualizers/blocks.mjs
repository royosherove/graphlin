import { structureScene } from './structure.mjs';
export const blocks = {
  id: 'graphlin.blocks', name: 'Blocks', renderer: 'graphlin-scene',
  project: ({ model, settings }) => structureScene(model, settings),
};
