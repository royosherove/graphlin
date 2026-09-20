import { ancestors, sceneKind } from '../visualizers/structure.mjs';

const SHAPES = {
  client: 'browser', service: 'component', datastore: 'cylinder', queue: 'queue', external: 'cloud',
  module: 'rect', function: 'hexagon', class: 'class_box', interface: 'interface_box',
  event: 'document', configuration: 'parallelogram', package: 'folder', unknown: 'rect', group: 'group',
};

export function filterScene(scene, { query = '', kinds = null } = {}, model) {
  if (!query && kinds === null) return scene;
  const entities = new Map(model.entities.map(entity => [entity.id, entity]));
  const matches = entityId => {
    const entity = entities.get(entityId);
    return entity && (!kinds || kinds.has(entity.kind)) &&
      `${entity.label} ${entity.qualifiedName || ''}`.toLowerCase().includes(query.toLowerCase());
  };
  const retained = new Set(), groups = new Map(scene.groups.map(group => [group.id, group]));
  const keep = item => {
    retained.add(item.id);
    let parent = item.parentId;
    while (parent && !retained.has(parent)) { retained.add(parent); parent = groups.get(parent)?.parentId; }
  };
  scene.nodes.filter(node => matches(node.entityId)).forEach(keep);
  scene.groups.filter(group => group.entityIds.some(matches) ||
    (query && group.label.toLowerCase().includes(query.toLowerCase()) &&
      (!kinds || group.entityIds.some(id => kinds.has(entities.get(id)?.kind))))).forEach(keep);
  return { ...scene, nodes: scene.nodes.filter(node => retained.has(node.id)),
    groups: scene.groups.filter(group => retained.has(group.id)),
    edges: scene.edges.filter(edge => retained.has(edge.source) && retained.has(edge.target)) };
}

/** Containment uses padding and a title band; sibling boxes never overlap.
 * Layout algorithms still apply to ordinary flat scenes through the old viewer.
 */
export function layoutScene(scene) {
  const items = new Map([...scene.groups, ...scene.nodes].map(item => [item.id, { ...item }]));
  const groups = new Set(scene.groups.map(group => group.id)), children = new Map();
  for (const item of items.values()) {
    const parent = item.parentId || null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  function pack(parent, x, y) {
    const siblings = children.get(parent) || [];
    let cursorX = x, cursorY = y, rowHeight = 0, maxX = x;
    const columns = Math.max(1, Math.ceil(Math.sqrt(siblings.length)));
    siblings.forEach((item, index) => {
      if (index && index % columns === 0) { cursorX = x; cursorY += rowHeight + 64; rowHeight = 0; }
      item.x = cursorX; item.y = cursorY;
      if (groups.has(item.id) && !item.collapsed && children.has(item.id)) {
        const content = pack(item.id, cursorX + 28, cursorY + 64);
        item.width = Math.max(246, content.width + 56);
        item.height = Math.max(144, content.height + 92);
      } else {
        item.width = groups.has(item.id) ? Math.max(190, Math.min(300, item.label.length * 8 + 70)) : 190;
        item.height = 104;
      }
      cursorX += item.width + 80; maxX = Math.max(maxX, cursorX - 80);
      rowHeight = Math.max(rowHeight, item.height);
    });
    return { width: maxX - x, height: cursorY - y + rowHeight };
  }
  pack(null, 0, 0);
  return { ...scene, groups: scene.groups.map(group => items.get(group.id)), nodes: scene.nodes.map(node => items.get(node.id)) };
}

export function sceneGraph(scene, model) {
  const entities = new Map(model.entities.map(entity => [entity.id, entity]));
  const relations = new Map(model.relations.map(relation => [relation.id, relation]));
  const claim = entity => ({
    sourceRefs: entity?.sourceRefs || [], validity: entity?.validity || 'current',
    classification: entity?.classification || 'unknown', basis: entity?.basis || 'metadata',
    evidenceState: entity?.basis === 'parsed' ? 'observed' : 'proposed', activityState: 'idle',
  });
  const active = new Map();
  for (const event of model.activity) for (const id of event.entityIds || []) active.set(id, event.outcome);
  const nodes = [
    ...scene.groups.map(group => {
      const entity = entities.get(group.entityIds[0]);
      const interpretation = group.membershipId && model.interpretations.find(value => value.id === group.membershipId);
      return { ...claim(interpretation || entity), ...group, kind: group.kind || entity?.kind || 'unknown',
        entityId: entity?.id, shape: 'group', isGroup: true, label: group.label,
        memberCount: group.entityIds.length, activityCount: group.entityIds.filter(id => active.has(id)).length,
        activityState: 'idle' };
    }),
    ...scene.nodes.map(node => {
      const entity = entities.get(node.entityId);
      return { ...claim(entity), ...node, kind: entity?.kind || node.kind,
        shape: node.shape || SHAPES[sceneKind(node.kind)] || 'rect',
        activityState: active.get(node.entityId) === 'pending' ? 'pending' : active.get(node.entityId) === 'failed' ? 'failed' : 'idle' };
    }),
  ].map(node => ({ x: 0, y: 0, ...node }));
  return { revision: model.revision, nodes, edges: scene.edges.map(edge => ({
    ...claim(relations.get(edge.relationIds?.[0])), ...edge, relation: edge.kind,
    label: edge.label || edge.kind.replaceAll('_', ' '),
    sourceRefs: (edge.relationIds || []).flatMap(id => relations.get(id)?.sourceRefs || []).slice(0, 32),
  })) };
}

export function representedSelection(entityId, scene, model) {
  if (!entityId) return null;
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  for (const id of [entityId, ...ancestors(entityId, byId)]) {
    const node = scene.nodes.find(node => node.entityId === id);
    if (node) return node.id;
    // Reverse order prefers a deeper group over an outer frame.
    const group = [...scene.groups].reverse().find(group => group.entityIds.includes(id));
    if (group) return group.id;
  }
  return null;
}
