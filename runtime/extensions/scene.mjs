import {
  SCENE_VERSION, EXTENSION_LIMITS as L, check, exact, id, integer,
  text, uniqueStrings, jsonBytes,
} from './contracts.mjs';

export const SCENE_KINDS = Object.freeze([
  'client', 'service', 'datastore', 'queue', 'external', 'module', 'function',
  'class', 'interface', 'event', 'configuration', 'package', 'group', 'unknown',
]);
export const SCENE_SHAPES = Object.freeze([
  'rounded_rect', 'rect', 'cylinder', 'cloud', 'diamond', 'group', 'hexagon',
  'class_box', 'interface_box', 'document', 'parallelogram', 'folder', 'browser', 'component', 'queue',
]);
export const EDGE_KINDS = Object.freeze([
  'calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on', 'contains',
  'imports', 'references', 'member_of', 'hosted_by', 'unknown',
]);
const STATES = ['default', 'muted', 'selected', 'active', 'pending', 'failed', 'stale',
  'tentative', 'added', 'modified', 'removed', 'discovered', 'unknown'];
const BOX_FIELDS = ['parentId', 'x', 'y', 'width', 'height', 'style', 'shape', 'collapsed'];

function box(value) {
  check(value.parentId === undefined || value.parentId === null || id(value.parentId), 'invalid_scene_parent');
  for (const field of ['x', 'y']) {
    check(value[field] === undefined ||
      (Number.isFinite(value[field]) && Math.abs(value[field]) <= L.coordinate), 'invalid_scene_coordinate');
  }
  for (const field of ['width', 'height']) {
    check(value[field] === undefined ||
      (Number.isFinite(value[field]) && value[field] > 0 && value[field] <= L.dimension), 'invalid_scene_size');
  }
  check(value.style === undefined || STATES.includes(value.style), 'invalid_scene_style');
  check(value.shape === undefined || SCENE_SHAPES.includes(value.shape), 'invalid_scene_shape');
  check(value.collapsed === undefined || typeof value.collapsed === 'boolean', 'invalid_scene_group');
}

/** Returns a detached scene, throwing a fixed code on invalid/unbounded output.
 * Pass the delivered model to verify mappings, never the unprojected core state.
 */
export function validateScene(scene, { model } = {}) {
  check(exact(scene, ['sceneVersion', 'nodes', 'groups', 'edges'], ['coverage']), 'invalid_scene');
  check(scene.sceneVersion === SCENE_VERSION, 'incompatible_scene');
  check(Array.isArray(scene.nodes) && scene.nodes.length <= L.nodes &&
    Array.isArray(scene.groups) && scene.groups.length <= L.groups &&
    Array.isArray(scene.edges) && scene.edges.length <= L.edges, 'scene_item_limit');
  jsonBytes(scene, L.sceneBytes, 'scene_byte_limit');
  const entities = model ? new Set(model.entities.map(value => value.id)) : null;
  const relations = model ? new Map(model.relations.map(value => [value.id, value])) : null;
  const items = new Map();
  const groups = new Set(scene.groups.map(value => value?.id));
  for (const [values, isGroup] of [[scene.nodes, false], [scene.groups, true]]) {
    for (const value of values) {
      const required = isGroup ? ['id', 'entityIds', 'label'] : ['id', 'entityId', 'label', 'kind'];
      check(exact(value, required, [...BOX_FIELDS, ...(isGroup ? ['kind', 'membershipId'] : [])]) &&
        id(value.id) && text(value.label) && !items.has(value.id), 'invalid_scene_node');
      if (isGroup) {
        check(uniqueStrings(value.entityIds, id, L.members) && value.entityIds.length > 0 &&
          (value.membershipId === undefined || id(value.membershipId)), 'invalid_scene_mapping');
      } else check(id(value.entityId), 'invalid_scene_mapping');
      check((isGroup && value.kind === undefined) || SCENE_KINDS.includes(value.kind), 'invalid_scene_kind');
      const members = isGroup ? value.entityIds : [value.entityId];
      check(!entities || members.every(member => entities.has(member)), 'unknown_scene_entity');
      box(value);
      items.set(value.id, { ...value, members });
    }
  }
  for (const item of items.values()) {
    const seen = new Set([item.id]);
    let parent = item.parentId;
    while (parent !== undefined && parent !== null) {
      check(groups.has(parent) && !seen.has(parent), 'invalid_scene_parent');
      seen.add(parent);
      parent = items.get(parent).parentId;
    }
  }
  const edgeIds = new Set();
  for (const edge of scene.edges) {
    check(exact(edge, ['id', 'source', 'target', 'kind'], ['relationIds', 'label', 'count', 'style']) &&
      id(edge.id) && !edgeIds.has(edge.id) && !items.has(edge.id) &&
      items.has(edge.source) && items.has(edge.target) && EDGE_KINDS.includes(edge.kind), 'invalid_scene_edge');
    check(edge.label === undefined || text(edge.label), 'invalid_scene_text');
    check(edge.style === undefined || STATES.includes(edge.style), 'invalid_scene_style');
    check(edge.count === undefined || (integer(edge.count, 1_000_000) && edge.count > 0), 'invalid_scene_count');
    check(edge.relationIds === undefined || uniqueStrings(edge.relationIds, id, L.members), 'invalid_scene_mapping');
    if (relations) {
      check(edge.relationIds?.length > 0, 'missing_scene_relation');
      for (const relationId of edge.relationIds) {
        const relation = relations.get(relationId);
        check(relation && relation.kind === edge.kind &&
          items.get(edge.source).members.includes(relation.source) &&
          items.get(edge.target).members.includes(relation.target), 'invalid_scene_relation');
      }
      check(edge.count === undefined || edge.count === edge.relationIds.length, 'invalid_scene_count');
    }
    edgeIds.add(edge.id);
  }
  if (scene.coverage !== undefined) {
    check(exact(scene.coverage, [], ['shown', 'total', 'truncated', 'label']) &&
      (scene.coverage.shown === undefined || integer(scene.coverage.shown)) &&
      (scene.coverage.total === undefined || integer(scene.coverage.total)) &&
      (scene.coverage.truncated === undefined || typeof scene.coverage.truncated === 'boolean') &&
      (scene.coverage.label === undefined || text(scene.coverage.label)), 'invalid_scene_coverage');
  }
  return JSON.parse(JSON.stringify(scene));
}
