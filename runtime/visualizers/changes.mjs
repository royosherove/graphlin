import { compareCheckpoint } from '../model/changes.mjs';
import { structureScene } from './structure.mjs';

export function changesScene(model, settings = {}, baseline) {
  if (!baseline || baseline.projectId !== model.projectId || baseline.sequence > model.sequence) {
    const scene = structureScene(model, settings);
    scene.coverage.label = 'Choose a retained checkpoint as the task baseline';
    return scene;
  }
  const completeCoverage = value => ({ ...value,
    coverage: { ...value.coverage, enumerations: value.coverage?.enumerations || [] } });
  const changes = compareCheckpoint(completeCoverage(baseline), completeCoverage(model), settings.baseline);
  const styles = new Map();
  for (const [key, style] of Object.entries({
    discoveries: 'discovered', creations: 'added', modifications: 'modified', removals: 'removed', invalidations: 'stale',
  })) for (const value of changes[key]) styles.set((value.after || value).id, style);
  const scene = structureScene(model, settings, { styles });
  scene.coverage.label = `Since revision ${baseline.revision}: ${changes.discoveries.length} discovered, ` +
    `${changes.creations.length} created, ${changes.modifications.length} modified, ` +
    `${changes.removals.length} removed, ${changes.invalidations.length} invalidated`;
  return scene;
}
export const changes = { id: 'graphlin.changes', name: 'Changes', renderer: 'graphlin-scene',
  project: ({ model, settings, baseline }) => changesScene(model, settings, baseline) };
