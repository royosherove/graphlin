import { SCENE_KINDS, EDGE_KINDS } from '../extensions/scene.mjs';

export const emptyScene = () => ({ sceneVersion: 1, nodes: [], groups: [], edges: [] });
export const sceneKind = kind => SCENE_KINDS.includes(kind) ? kind :
  ({ method: 'function', namespace: 'module', enum: 'class', type_alias: 'interface',
    variable: 'module', directory: 'package', file: 'module', project: 'package' }[kind] || 'unknown');

export function entityIndex(model) {
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  const children = new Map();
  for (const entity of byId.values()) {
    const parent = byId.has(entity.parentId) ? entity.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entity.id);
  }
  return { byId, children };
}

export function ancestors(id, byId) {
  const result = [], seen = new Set([id]);
  let parent = byId.get(id)?.parentId;
  while (byId.has(parent) && !seen.has(parent)) {
    seen.add(parent); result.push(parent); parent = byId.get(parent).parentId;
  }
  return result;
}

function descendants(id, children) {
  const result = [], pending = [id], seen = new Set();
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const next = pending[cursor];
    if (seen.has(next)) continue;
    seen.add(next); result.push(next);
    pending.push(...(children.get(next) || []));
  }
  return result;
}

export function aggregateEdges(model, scene) {
  const owner = new Map();
  // The most specific visible item owns an endpoint. Expanded group membership
  // includes descendants, but must not hide a visible child's own relationships.
  for (const group of scene.groups) for (const id of group.entityIds) owner.set(id, group.id);
  for (const node of scene.nodes) owner.set(node.entityId, node.id);
  const combined = new Map();
  for (const relation of model.relations) {
    const source = owner.get(relation.source), target = owner.get(relation.target);
    if (!source || !target || source === target || relation.kind === 'contains' ||
      !EDGE_KINDS.includes(relation.kind)) continue;
    const key = JSON.stringify([source, target, relation.kind, relation.validity]);
    if (!combined.has(key)) {
      if (combined.size >= 768) continue;
      combined.set(key, {
        id: `link.${combined.size}`, source, target, kind: relation.kind, relationIds: [],
        style: relation.validity === 'current' ? 'default' : 'stale',
      });
    }
    const edge = combined.get(key);
    if (edge.relationIds.length < 256) edge.relationIds.push(relation.id);
  }
  scene.edges = [...combined.values()].map(edge => ({
    ...edge, count: edge.relationIds.length,
    label: `${edge.kind.replaceAll('_', ' ')}${edge.relationIds.length > 1 ? ` (${edge.relationIds.length})` : ''}`,
  }));
  return scene;
}

export function structureScene(model, settings = {}, { flat = false, styles = new Map() } = {}) {
  const scene = emptyScene();
  const { byId, children } = entityIndex(model);
  const expanded = new Set(settings.expanded || []);
  const needle = (settings.query || '').toLowerCase();
  const types = settings.kinds ? new Set(settings.kinds) : null;
  const filtering = Boolean(needle || types);
  const matches = new Set(model.entities.filter(entity =>
    (!needle || `${entity.label} ${entity.qualifiedName || ''}`.toLowerCase().includes(needle)) &&
    (!types || types.has(entity.kind))).map(entity => entity.id));
  const relevant = new Set(matches);
  if (filtering) for (const id of matches) for (const parent of ancestors(id, byId)) {
    relevant.add(parent); expanded.add(parent);
  }
  const roots = settings.scope && byId.has(settings.scope) ? [settings.scope] : (children.get(null) || []);
  const pending = roots.map(id => ({ id, parentId: null, depth: 0 }));
  const visited = new Set();
  while (pending.length && scene.nodes.length + scene.groups.length < 256) {
    const { id, parentId, depth } = pending.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const entity = byId.get(id);
    if (!entity || (filtering && !relevant.has(id))) continue;
    const childIds = children.get(id) || [];
    const style = styles.get(id) || (entity.validity !== 'current' ? 'stale' :
      entity.classification === 'tentative' ? 'tentative' : 'default');
    if (!flat && childIds.length && scene.groups.length < 64) {
      const members = descendants(id, children);
      const collapsed = !(expanded.has(id) || (!settings.collapsed?.includes(id) && depth < (settings.depth ?? 1)));
      const changed = members.filter(member => styles.has(member));
      scene.groups.push({
        id, entityIds: members.slice(0, 256),
        label: changed.length ? `${entity.label.slice(0, 200)} (${changed.length} changed)` : entity.label,
        kind: sceneKind(entity.kind), ...(parentId ? { parentId } : {}), collapsed,
        style: styles.get(id) || (changed.length ? styles.get(changed[0]) : style),
      });
      if (!collapsed) pending.push(...childIds.map(child => ({ id: child, parentId: id, depth: depth + 1 })));
    } else {
      if (!filtering || matches.has(id)) scene.nodes.push({
        id, entityId: id, label: entity.label, kind: sceneKind(entity.kind), style,
        ...(parentId ? { parentId } : {}),
      });
      if (flat || childIds.length) pending.push(...childIds.map(child => ({ id: child, parentId, depth: depth + 1 })));
    }
  }
  scene.coverage = {
    shown: scene.nodes.length + scene.groups.length, total: model.entities.length,
    truncated: pending.length > 0 || scene.groups.some(group =>
      (children.get(group.id) || []).length > 0 && group.entityIds.length === 256),
    label: 'Source structure; discovery may be incomplete',
  };
  return aggregateEdges(model, scene);
}
