import { code } from './code.mjs';
import { blocks } from './blocks.mjs';
import { c4 } from './c4.mjs';
import { changes } from './changes.mjs';
import { timeline } from './timeline.mjs';
import { validateScene } from '../extensions/scene.mjs';

export const BUILTIN_VIEWS = Object.freeze([code, blocks, c4, changes, timeline]);

export function createBuiltin(id, context) {
  const definition = BUILTIN_VIEWS.find(view => view.id === id);
  if (!definition) throw new Error('unknown_visualizer');
  const custom = definition.create?.(context);
  let disposed = false;
  return {
    update(input) {
      if (disposed) throw new Error('extension_disposed');
      if (custom) return custom.update(input);
      return { kind: 'scene', scene: validateScene(definition.project(input), { model: input.model }) };
    },
    dispose() { disposed = true; custom?.dispose(); },
  };
}
