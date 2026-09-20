import { structureScene, aggregateEdges, sceneKind, emptyScene, entityIndex } from './structure.mjs';

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
  const { byId, children: sourceChildrenById } = entityIndex(model);
  const supported = model.interpretations.filter(value =>
    value.validity === 'current' && value.support === 'supported' &&
    value.classification === 'accepted' && value.sourceRefs?.length &&
    value.entityIds?.some(id => byId.has(id))).map(value => ({
      ...value, members: value.entityIds.filter(id => byId.has(id)), memberSet: new Set(value.entityIds),
    }));
  if (!supported.some(value => level.has(value.kind))) {
    const scene = structureScene(model, { ...settings, depth: 0 });
    scene.coverage.label = 'Source scopes; application and responsibility boundaries unknown';
    scene.groups.forEach(group => { group.style = 'unknown'; });
    scene.nodes.forEach(node => { node.style = 'unknown'; });
    return scene;
  }
  const applications = supported.filter(value => LEVELS.applications.has(value.kind));
  const components = supported.filter(value => LEVELS.components.has(value.kind));
  const parents = new Map(), children = new Map();
  const explicitParents = new Map();
  for (const membership of supported.filter(value =>
    value.namespace === 'graphlin.architecture' && value.kind === 'architecture_membership')) {
    const anchors = membership.entityIds;
    if (anchors.length !== 2 || anchors[0] === anchors[1] ||
      anchors.some(id => byId.get(id)?.validity !== 'current')) continue;
    const parent = applications.filter(value => value.kind === 'application' &&
      value.entityIds.length === 1 && anchors.includes(value.entityIds[0]));
    const child = components.filter(value => value.entityIds.length === 1 && anchors.includes(value.entityIds[0]));
    if (parent.length !== 1 || child.length !== 1 || parent[0].entityIds[0] === child[0].entityIds[0]) continue;
    if (!explicitParents.has(child[0].id)) explicitParents.set(child[0].id, new Set());
    explicitParents.get(child[0].id).add(parent[0].id);
  }
  for (const component of components) {
    // Host architecture uses small, source-backed anchor pairs. Other
    // interpretations can still establish containment by a unique strict subset.
    const explicit = explicitParents.get(component.id);
    const candidates = explicit ? applications.filter(value => explicit.has(value.id))
      : component.namespace === 'graphlin.architecture' ? []
      : applications.filter(application => component.memberSet.size < application.memberSet.size &&
        [...component.memberSet].every(id => application.memberSet.has(id)));
    if (candidates.length !== 1) continue;
    const parent = candidates[0];
    parents.set(component.id, parent.id);
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(component);
  }
  const descendants = anchor => {
    const pending = [anchor], visited = new Set();
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index];
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(sourceChildrenById.get(id) || []));
    }
    return [...visited];
  };
  for (const boundary of [...applications, ...components]) {
    if (boundary.namespace === 'graphlin.architecture' && boundary.members.length === 1)
      boundary.members = descendants(boundary.members[0]);
  }
  for (const application of applications) {
    // This is a bounded display projection, not a persisted union of evidence
    // references or a new application-membership claim.
    application.members = [...new Set([...application.members,
      ...(children.get(application.id) || []).flatMap(component => component.members)])];
  }
  const roots = level === LEVELS.components
    ? [...applications.filter(value => children.has(value.id)), ...components.filter(value => !parents.has(value.id))]
    : supported.filter(value => level.has(value.kind));
  const expanded = new Set(settings.expanded || []), collapsed = new Set(settings.collapsed || []);
  const legacyKeys = new Map();
  for (const boundary of supported.filter(value => value.kind !== 'architecture_membership'))
    legacyKeys.set(boundary.members[0], (legacyKeys.get(boundary.members[0]) || 0) + 1);
  const query = (settings.query || '').toLowerCase(), kinds = settings.kinds ? new Set(settings.kinds) : null;
  const matching = id => {
    const entity = byId.get(id);
    return entity && (!query || `${entity.label} ${entity.qualifiedName || ''}`.toLowerCase().includes(query)) &&
      (!kinds || kinds.has(entity.kind));
  };
  function isExpanded(id, members, defaultOpen = false) {
    if ((query || kinds) && members.some(matching)) return true;
    if (collapsed.has(id)) return false;
    if (expanded.has(id)) return true;
    // Older in-memory settings used a group's first source member. Keep that
    // fallback only when it identifies a single interpretation.
    const legacy = members[0];
    if (legacyKeys.get(legacy) === 1) {
      if (collapsed.has(legacy)) return false;
      if (expanded.has(legacy)) return true;
    }
    return defaultOpen;
  }
  const scene = emptyScene(), represented = new Set(), emitted = new Set(), sourceNodes = new Set();
  let truncated = false;
  function sourceChildren(members, parentId, excluded = new Set()) {
    for (const id of members) {
      if (excluded.has(id) || sourceNodes.has(id)) continue;
      const entity = byId.get(id);
      if (entity.validity === 'retracted') continue;
      if (scene.nodes.length + scene.groups.length >= 255) { truncated = true; break; }
      const style = entity.validity !== 'current' ? 'stale' :
        entity.classification === 'tentative' ? 'tentative' : 'default';
      scene.nodes.push({ id, entityId: id, label: entity.label, kind: sceneKind(entity.kind), parentId, style });
      sourceNodes.add(id);
    }
  }
  function addBoundary(boundary, parentId) {
    if (emitted.has(boundary.id)) return;
    if (scene.groups.length >= 63 || scene.nodes.length + scene.groups.length >= 255) { truncated = true; return; }
    emitted.add(boundary.id);
    const members = boundary.members.slice(0, 256), id = `c4.${boundary.id}`;
    boundary.members.forEach(member => represented.add(member));
    if (boundary.members.length > members.length) truncated = true;
    const nested = level === LEVELS.context ? [] : children.get(boundary.id) || [];
    const open = isExpanded(id, members, boundary.kind === 'application' || nested.length > 0);
    scene.groups.push({
      id, entityIds: members, label: boundary.label, collapsed: !open,
      kind: sceneKind(KINDS[boundary.kind] || 'group'), membershipId: boundary.id,
      ...(parentId ? { parentId } : {}),
    });
    if (open) {
      for (const child of nested) addBoundary(child, id);
      const nestedMembers = new Set(nested.filter(child => emitted.has(child.id)).flatMap(child => child.members));
      sourceChildren(members, id, nestedMembers);
    }
  }
  for (const boundary of roots) addBoundary(boundary);
  const unknown = model.entities.filter(entity => !represented.has(entity.id));
  if (unknown.length) {
    const members = unknown.slice(0, 256).map(entity => entity.id), open = isExpanded('c4.unknown', members);
    scene.groups.push({
      id: 'c4.unknown', entityIds: members, label: 'Responsibility unknown',
      kind: 'unknown', collapsed: !open, style: 'unknown',
    });
    if (open) sourceChildren(members, 'c4.unknown');
    if (unknown.length > members.length) truncated = true;
  }
  scene.coverage = { shown: scene.groups.length + scene.nodes.length, total: model.entities.length, truncated,
    label: 'Supported interpretations; source does not establish runtime hosting' };
  return aggregateEdges(model, scene);
}
export const c4 = { id: 'graphlin.c4', name: 'C4', renderer: 'graphlin-scene',
  project: ({ model, settings }) => c4Scene(model, settings) };
