import { structureScene, aggregateEdges, sceneKind, emptyScene } from './structure.mjs';

const LEVELS = {
  context: new Set(['system', 'external_system', 'actor', 'person', 'context']),
  applications: new Set(['application', 'datastore', 'container']),
  components: new Set(['component']),
};
const KINDS = { application: 'service', container: 'service', datastore: 'datastore',
  component: 'service', actor: 'client', person: 'client', external_system: 'external', system: 'group' };

export function c4Scene(model, settings = {}) {
  if (settings.level === 'code') return structureScene(model, settings, { flat: true });
  const level = LEVELS[settings.level] || LEVELS.applications;
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  const boundaries = model.interpretations.filter(value =>
    level.has(value.kind) && value.validity === 'current' && value.support === 'supported' &&
    value.classification === 'accepted' && value.sourceRefs?.length &&
    value.entityIds?.some(id => byId.has(id)));
  if (!boundaries.length) {
    const scene = structureScene(model, { ...settings, depth: 0 });
    scene.coverage.label = 'Source scopes; application and responsibility boundaries unknown';
    scene.groups.forEach(group => { group.style = 'unknown'; });
    scene.nodes.forEach(node => { node.style = 'unknown'; });
    return scene;
  }
  const scene = emptyScene(), represented = new Set();
  for (const boundary of boundaries.slice(0, 63)) {
    const members = boundary.entityIds.filter(id => byId.has(id)).slice(0, 256);
    members.forEach(id => represented.add(id));
    const expanded = settings.expanded?.includes(members[0]);
    scene.groups.push({
      id: `c4.${boundary.id}`, entityIds: members, label: boundary.label, collapsed: !expanded,
      kind: sceneKind(KINDS[boundary.kind] || 'group'), membershipId: boundary.id,
    });
    if (expanded) for (const id of members) {
      if (scene.nodes.length + scene.groups.length >= 255 || scene.nodes.some(node => node.entityId === id)) continue;
      const entity = byId.get(id);
      scene.nodes.push({ id, entityId: id, label: entity.label, kind: sceneKind(entity.kind), parentId: `c4.${boundary.id}` });
    }
  }
  const unknown = model.entities.filter(entity => !represented.has(entity.id)).slice(0, 256);
  if (unknown.length) scene.groups.push({
    id: 'c4.unknown', entityIds: unknown.map(entity => entity.id), label: 'Responsibility unknown',
    kind: 'unknown', collapsed: true, style: 'unknown',
  });
  scene.coverage = { shown: scene.groups.length, total: model.entities.length,
    truncated: represented.size + unknown.length < model.entities.length || boundaries.length > 63,
    label: 'Supported interpretations; source does not establish runtime hosting' };
  return aggregateEdges(model, scene);
}
export const c4 = { id: 'graphlin.c4', name: 'C4', renderer: 'graphlin-scene',
  project: ({ model, settings }) => c4Scene(model, settings) };
