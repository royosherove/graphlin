import { structureScene } from './structure.mjs';
export const code = {
  id: 'graphlin.code', name: 'Code', renderer: 'graphlin-scene',
  project: ({ model, settings }) => structureScene(model, settings, { flat: true }),
};
