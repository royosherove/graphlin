import { ancestors, sceneKind } from '../visualizers/structure.mjs';

const SHAPES = {
  client: 'browser', service: 'component', datastore: 'cylinder', queue: 'queue', external: 'cloud',
  module: 'rect', function: 'hexagon', class: 'class_box', interface: 'interface_box',
  event: 'document', configuration: 'parallelogram', package: 'folder', unknown: 'rect', group: 'group',
};

const TERMINAL = new Set(['succeeded', 'failed', 'denied', 'interrupted', 'unresolved']);
const ACTIVE_MS = 60_000, RECENT_MS = 4_000;

/** Journal pages may arrive newest-first or repeat records. A mapping is target
 * enrichment, never a fresh tool request or a new completion timestamp.
 */
export function createToolActivity() {
  let context, calls = new Map();
  return {
    update(model, { session, replay = false, now = Date.now() } = {}) {
      const next = JSON.stringify([model.projectId, session || null, replay]);
      if (context !== next) { calls.clear(); context = next; }
      const started = [];
      if (replay) return started;
      for (const event of [...(model.activity || [])].sort((a, b) => a.sequence - b.sequence)) {
        if ((session && event.sessionId !== session) || !event.toolCallId ||
          !Number.isSafeInteger(event.sequence)) continue;
        const mapped = event.kind === 'activity.mapped';
        const requested = event.kind === 'tool.requested';
        const outcome = requested ? 'pending' : event.kind === 'tool.finished' || mapped
          ? event.outcome : event.kind?.replace(/^tool\./, '');
        if (!mapped && !requested && !TERMINAL.has(outcome)) continue;
        const key = JSON.stringify([event.sessionId || '', event.agentId || '', event.toolCallId]);
        let call = calls.get(key);
        if (!call) {
          call = { key, sequence: -1, lifecycleSequence: -1, targetSequence: -1,
            entityIds: [], artifactIds: [] };
          calls.set(key, call);
        }
        call.sequence = Math.max(call.sequence, event.sequence);
        if (event.sequence > call.targetSequence) {
          // Target sets are authoritative. An exact terminal withdraws stale
          // semantic targets; an older mapping page cannot add them back.
          call.targetSequence = event.sequence;
          for (const field of ['entityIds', 'artifactIds']) call[field] = [...new Set(event[field] || [])].slice(0, 256);
          if (['read', 'edit'].includes(event.operation)) call.operation = event.operation;
          if (['exact', 'decision'].includes(event.mapping)) call.mapping = event.mapping;
        }
        const time = Date.parse(event.at);
        if (!Number.isFinite(time)) continue;
        const at = Math.min(time, now);
        if (mapped) {
          // The terminal record can be outside a bounded page. Its copied
          // outcome prevents an older requested page from reviving the call.
          if (TERMINAL.has(outcome) && event.sequence > (call.mappedSequence ?? -1)) {
            call.mappedTerminal = { outcome, at }; call.mappedSequence = event.sequence;
          }
          continue;
        }
        if (event.sequence <= call.lifecycleSequence) continue;
        call.lifecycleSequence = event.sequence;
        if (requested && call.outcome) continue;
        call.outcome = outcome; call.at = at;
        if (requested) started.push(key);
      }
      if (calls.size > 2048) calls = new Map([...calls].sort((a, b) => b[1].sequence - a[1].sequence).slice(0, 2048));
      return started;
    },
    current(now = Date.now()) {
      const visible = [];
      for (const call of calls.values()) {
        if (!call.outcome || !call.operation) continue;
        let { outcome, at } = call;
        if (outcome === 'pending' && call.mappedTerminal) ({ outcome, at } = call.mappedTerminal);
        if (outcome === 'pending' && now >= at + ACTIVE_MS) { outcome = 'unresolved'; at += ACTIVE_MS; }
        const active = outcome === 'pending', expires = at + (active ? ACTIVE_MS : RECENT_MS);
        if (now >= expires) continue;
        const verb = call.operation === 'read' ? 'Read' : 'Edit';
        const label = active ? `${verb}ing` : outcome === 'succeeded' ? (verb === 'Read' ? verb : 'Edited') : `${verb} ${outcome}`;
        visible.push({ ...call, outcome, at, active, expires, label,
          opacity: active ? 1 : Math.min(1, Math.max(0, (expires - now) / 1000)) });
      }
      return visible.sort((a, b) => Number(b.active) - Number(a.active) || b.lifecycleSequence - a.lifecycleSequence);
    },
    clear() { calls.clear(); context = null; },
  };
}

/** Resolve an exact file even when its earlier metadata-only entity was replaced.
 * File activity does not claim that every parsed method was inspected.
 */
export function activityTargets(call, model) {
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  const ids = call.entityIds.filter(id => byId.has(id) && byId.get(id).validity !== 'retracted');
  const artifacts = new Set(call.artifactIds);
  for (const entity of model.entities) {
    if (!artifacts.has(entity.artifactId) || entity.validity === 'retracted' ||
      ['project', 'directory'].includes(entity.kind)) continue;
    const parent = byId.get(entity.parentId);
    if (!parent || parent.artifactId !== entity.artifactId || ['project', 'directory'].includes(parent.kind)) ids.push(entity.id);
  }
  return [...new Set(ids)];
}

/** Host-owned badges also reach visible containers whose bounded member list
 * omitted the leaf: canonical source ancestry supplies that containment.
 */
export function sceneActivity(scene, model, calls) {
  const byId = new Map(model.entities.map(entity => [entity.id, entity]));
  const items = [...scene.groups, ...scene.nodes], result = new Map();
  for (const call of calls) {
    const family = new Set(activityTargets(call, model).flatMap(id => [id, ...ancestors(id, byId)]));
    const represented = new Set(items.filter(item => item.entityIds
      ? item.entityIds.some(id => family.has(id)) : family.has(item.entityId)).map(item => item.id));
    for (const item of items) if (represented.has(item.id)) {
      let parent = item.parentId;
      while (parent && !represented.has(parent)) { represented.add(parent); parent = items.find(value => value.id === parent)?.parentId; }
    }
    for (const id of represented) {
      if (!result.has(id)) result.set(id, []);
      const badges = result.get(id), same = badges.find(value => value.operation === call.operation && value.outcome === call.outcome);
      if (same) { same.count++; same.opacity = Math.max(same.opacity, call.opacity); }
      else badges.push({ ...call, count: 1 });
    }
  }
  for (const badges of result.values()) badges.sort((a, b) => (a.operation === b.operation
    ? Number(b.active) - Number(a.active) : a.operation === 'read' ? -1 : 1));
  return result;
}

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
  const nodes = [
    ...scene.groups.map(group => {
      const entity = entities.get(group.entityIds[0]);
      const interpretation = group.membershipId && model.interpretations.find(value => value.id === group.membershipId);
      return { ...claim(interpretation || entity), ...group, kind: group.kind || entity?.kind || 'unknown',
        entityId: entity?.id, shape: 'group', isGroup: true, label: group.label,
        memberCount: group.entityIds.length, activityCount: 0,
        activityState: 'idle' };
    }),
    ...scene.nodes.map(node => {
      const entity = entities.get(node.entityId);
      return { ...claim(entity), ...node, kind: entity?.kind || node.kind,
        shape: node.shape || SHAPES[sceneKind(node.kind)] || 'rect' };
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
