import { sketchOutline } from './sketch.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const THEMES = ['sketchbook', 'ocean', 'forest', 'sunset', 'berry', 'sepia', 'blueprint', 'midnight'];
const ROLES = ['client', 'service', 'datastore', 'queue', 'external', 'module', 'function', 'class', 'interface', 'event', 'configuration', 'package'];
const ROLE_SHAPES = {
  client: 'browser', service: 'component', datastore: 'cylinder', queue: 'queue', external: 'cloud',
  module: 'rect', function: 'hexagon', class: 'class_box', interface: 'interface_box',
  event: 'document', configuration: 'parallelogram', package: 'folder',
};
const LIMITS = { hooks: 200, frames: 101, cards: 30, tiles: 12, sessions: 16 };
const CHANGES = { added: ['+', 'Added'], removed: ['−', 'Removed'], changed: ['↻', 'Changed'] };
const CLAIM_FIELDS = ['id', 'label', 'evidenceState', 'classification', 'validity'];
const NODE_FIELDS = [...CLAIM_FIELDS, 'kind', 'shape'];
const EDGE_FIELDS = [...CLAIM_FIELDS, 'source', 'target', 'relation'];
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 180) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : '';
const revision = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : null;
};
const shortSession = value => text(value).replace(/^session-/, '').slice(-8);
const itemKey = (type, id) => JSON.stringify([type, id]);

function html(document, tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.setAttribute('class', className);
  return element;
}

function svg(document, tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function timeLabel(document, value) {
  const at = timestamp(value);
  const element = html(document, 'time', at === null ? 'Time unavailable'
    : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  if (at !== null) {
    element.setAttribute('datetime', new Date(at).toISOString());
    element.setAttribute('title', new Date(at).toLocaleString());
  }
  return element;
}

// Keep only visible architectural meaning. Layout, activity, confidence and
// changing source excerpts must not produce a strip of fictional shape edits.
function semanticGraph(graph) {
  const claim = item => ({
    id: text(item.id), label: text(item.label), evidenceState: text(item.evidenceState, 40),
    classification: text(item.classification, 40), validity: text(item.validity, 40),
  });
  return {
    nodes: list(graph?.nodes).slice(0, 500).map(item => ({
      ...claim(item), kind: ROLES.includes(item.kind) ? item.kind : 'module', shape: text(item.shape, 32),
    })),
    edges: list(graph?.edges).slice(0, 1500).map(item => ({
      ...claim(item), source: text(item.source), target: text(item.target), relation: text(item.relation, 40),
    })),
  };
}

function sameItem(cached, incoming, fields) {
  if (!cached || !incoming) return false;
  return fields.every(field => cached[field] === (field === 'kind'
    ? ROLES.includes(incoming.kind) ? incoming.kind : 'module'
    : text(incoming[field], field === 'shape' ? 32 : ['evidenceState', 'classification', 'validity', 'relation'].includes(field) ? 40 : 180)));
}

function sameGraph(cached, incoming) {
  const nodes = list(incoming?.nodes), edges = list(incoming?.edges);
  return cached.nodes.length === Math.min(nodes.length, 500) && cached.edges.length === Math.min(edges.length, 1500)
    && cached.nodes.every((item, index) => sameItem(item, nodes[index], NODE_FIELDS))
    && cached.edges.every((item, index) => sameItem(item, edges[index], EDGE_FIELDS));
}

function frameStamp(frame) {
  // A retained revision is immutable architectural history. Its timestamp and
  // counts detect replacement; the current graph and visible labels are also
  // checked because privacy projection can change without a new revision.
  return `${timestamp(frame.at)}:${list(frame.graph.nodes).length}:${list(frame.graph.edges).length}`;
}

function renderSignature(entry) {
  return JSON.stringify([entry.revision, entry.at, entry.beforeRevision, entry.baseline,
    entry.baseline ? [entry.graph.nodes.length, entry.graph.edges.length] : [
      Object.keys(CHANGES).map(kind => entry.changes.filter(change => change.change === kind).length),
      entry.changes.slice(0, LIMITS.tiles),
    ]]);
}

function differences(before, after) {
  const changes = [];
  const beforeNames = new Map(before.nodes.map(node => [node.id, node.label || node.id]));
  const afterNames = new Map(after.nodes.map(node => [node.id, node.label || node.id]));
  function changeItem(type, change, item, names) {
    const label = type === 'edge'
      ? `${names.get(item.source) || item.source} ${item.label || item.relation.replaceAll('_', ' ')} ${names.get(item.target) || item.target}`
      : item.label || item.id;
    return { type, change, item, label };
  }
  for (const [type, collection] of [['node', 'nodes'], ['edge', 'edges']]) {
    const previous = new Map(before[collection].map(item => [item.id, item]));
    const current = new Map(after[collection].map(item => [item.id, item]));
    for (const item of after[collection]) {
      const older = previous.get(item.id);
      if (!older) changes.push(changeItem(type, 'added', item, afterNames));
      else if (JSON.stringify(older) !== JSON.stringify(item)) changes.push(changeItem(type, 'changed', item, afterNames));
    }
    for (const item of before[collection]) if (!current.has(item.id)) changes.push(changeItem(type, 'removed', item, beforeNames));
  }
  return changes;
}

function miniature(document, change) {
  const { item, type } = change;
  const image = svg(document, 'svg', {
    viewBox: '-20 -20 232 144', 'aria-hidden': 'true', focusable: 'false', class: 'change-miniature',
  });
  if (type === 'edge') {
    image.append(svg(document, 'path', {
      d: 'M 9 56 C 60 51 122 57 177 48 M 156 32 L 180 48 L 160 65',
      class: 'miniature-edge',
    }));
    return image;
  }
  const outlines = sketchOutline(item.shape, item.id);
  const paths = outlines.length ? outlines : sketchOutline(ROLE_SHAPES[item.kind], item.id);
  paths.forEach((d, index) => image.append(svg(document, 'path', {
    d, class: index ? 'miniature-outline miniature-second' : 'miniature-outline',
  })));
  const details = {
    cylinder: 'M 0 17 C 0 39 190 39 190 17',
    browser: 'M 0 23 L 190 23 M 13 12 L 19 12 M 28 12 L 34 12',
    class_box: 'M 0 35 L 190 35 M 0 68 L 190 68',
    interface_box: 'M 0 35 L 190 35',
    queue: 'M 30 0 L 30 104 M 160 0 L 160 104 M 75 52 L 116 52 M 101 38 L 117 52 L 101 66',
    document: 'M 167 0 L 167 23 L 190 23 M 24 47 L 156 47 M 24 68 L 132 68',
  }[item.shape || ROLE_SHAPES[item.kind]];
  if (details) image.append(svg(document, 'path', { d: details, class: 'miniature-detail' }));
  return image;
}

/**
 * Render already-normalized snapshots. Hooks remain project-wide and live;
 * shape history belongs only to the snapshot's project and selected session.
 * onInspect(type, id) opens a current node/edge. onReplay(revision) opens a
 * retained historical frame, including the frame before a removed item.
 */
export function createLiveSidebar({ onInspect, onReplay } = {}) {
  const document = globalThis.document;
  const ids = ['live-sidebar', 'sidebar-hooks', 'sidebar-hook-list', 'sidebar-hook-count',
    'sidebar-hook-dot', 'sidebar-hook-coverage', 'sidebar-hook-empty', 'sidebar-history',
    'sidebar-change-list', 'sidebar-change-count', 'sidebar-change-note', 'sidebar-change-empty'];
  const elements = Object.fromEntries(ids.map(id => [id, document?.getElementById(id)]));
  if (ids.some(id => !elements[id])) return { update() {}, destroy() {} };
  const $ = id => elements[id];
  const histories = new Map();
  const hookRows = new Map();
  const cards = new Map();
  const actions = new WeakMap();
  let currentItems = new Set();
  let availableRevisions = new Set();
  let availableSignature = '';
  let identity = null;
  let hookIdentity = null;
  let hookKeys = new Set();
  let pulse = null;
  let destroyed = false;
  function pulseReceipt() {
    const reduced = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || document.hidden) return;
    pulse?.cancel();
    pulse = $('sidebar-hook-dot').animate?.([
      { transform: 'scale(1)', boxShadow: '0 0 0 0 currentColor' },
      { transform: 'scale(1.35)', boxShadow: '0 0 0 5px transparent', offset: .5 },
      { transform: 'scale(1)', boxShadow: '0 0 0 8px transparent' },
    ], { duration: 700, easing: 'ease-out' }) ?? null;
  }

  function hooks(snapshot, replay) {
    const detailed = Array.isArray(snapshot.hookEvents);
    const incoming = detailed ? snapshot.hookEvents : list(snapshot.activity);
    const sorted = incoming.map((event, index) => ({ event, index })).sort((a, b) => {
      if (detailed && revision(a.event.receipt) && revision(b.event.receipt)) return b.event.receipt - a.event.receipt;
      return (timestamp(b.event.at) ?? 0) - (timestamp(a.event.at) ?? 0)
        || (b.event.sequence || 0) - (a.event.sequence || 0) || (detailed ? a.index - b.index : b.index - a.index);
    }).slice(0, LIMITS.hooks);
    const nextIdentity = JSON.stringify([snapshot.projectId, detailed ? 'hooks' : snapshot.sessionId, detailed]);
    const nextKeys = new Set();
    const rows = [];
    for (const { event, index } of sorted) {
      const key = JSON.stringify([nextIdentity, detailed && revision(event.receipt) ? event.receipt
        : [text(event.sessionId), text(event.id), text(event.kind), event.sequence, event.at, index]]);
      if (nextKeys.has(key)) continue;
      nextKeys.add(key);
      const signature = JSON.stringify([event.label, event.kind, event.toolCategory, event.state, event.at, event.sessionId]);
      let row = hookRows.get(key);
      if (!row || row.signature !== signature) {
        const element = html(document, 'li', undefined, 'hook-receipt');
        element.setAttribute('data-receipt', String(event.receipt ?? event.sequence ?? ''));
        const heading = html(document, 'div', undefined, 'hook-receipt-heading');
        const state = ['succeeded', 'failed', 'pending', 'interrupted', 'unresolved', 'observed'].includes(event.state) ? event.state : 'observed';
        const dot = html(document, 'i', undefined, 'event-dot');
        dot.setAttribute('aria-hidden', 'true');
        dot.dataset.state = state;
        heading.append(dot, html(document, 'strong', text(event.label) || 'Hook received'), timeLabel(document, event.at));
        const meta = html(document, 'p', undefined, 'hook-receipt-meta');
        const category = text(event.toolCategory, 50);
        meta.append(html(document, 'span', [text(event.kind, 60), category && category !== 'other' ? category : ''].filter(Boolean).join(' · ')));
        meta.append(html(document, 'span', shortSession(event.sessionId) ? `Session ${shortSession(event.sessionId)}` : 'Project'));
        element.append(heading, meta);
        if (state === 'failed' || state === 'interrupted' || state === 'unresolved') {
          element.append(html(document, 'span', state === 'unresolved' ? 'Outcome not known' : state[0].toUpperCase() + state.slice(1), 'hook-outcome'));
        }
        row = { element, signature };
        hookRows.set(key, row);
      }
      rows.push(row.element);
    }
    const hasNew = hookIdentity === nextIdentity && [...nextKeys].some(key => !hookKeys.has(key));
    hookIdentity = nextIdentity;
    hookKeys = nextKeys;
    for (const [key, row] of hookRows) if (!nextKeys.has(key)) { row.element.remove(); hookRows.delete(key); }
    reconcileChildren($('sidebar-hook-list'), rows);
    $('sidebar-hook-count').textContent = String(rows.length);
    $('sidebar-hook-dot').dataset.state = rows.length ? 'received' : 'waiting';
    $('sidebar-hook-coverage').textContent = detailed
      ? `Received hooks across this project. Up to ${LIMITS.hooks} shown.${replay ? ' This feed stays live during replay.' : ''}`
      : 'Detailed hook feed needs a server restart. Showing the selected session’s activity; this is not a list of every received hook.';
    $('sidebar-hook-empty').hidden = rows.length > 0;
    $('sidebar-hook-empty').textContent = detailed
      ? 'Waiting for hooks. Work in a connected agent to see each receipt here.'
      : 'No session activity received yet.';
    if (hasNew) pulseReceipt();
  }

  function actionLabel(action) {
    if (action.kind === 'revision') return `View diagram at revision ${action.revision}`;
    const { change, revision: at, beforeRevision } = action;
    if (change.change !== 'removed' && currentItems.has(itemKey(change.type, change.item.id)) && typeof onInspect === 'function') {
      return `Inspect current ${change.type === 'edge' ? 'connection' : 'component'} ${change.label}`;
    }
    const target = change.change === 'removed' ? beforeRevision : at;
    return availableRevisions.has(target) && typeof onReplay === 'function'
      ? `View ${change.change === 'removed' ? 'removed ' : ''}${change.label} at revision ${target}`
      : `Historical view of ${change.label} is no longer available`;
  }

  function refreshAction(button, action) {
    const current = action.kind !== 'revision' && action.change.change !== 'removed'
      && currentItems.has(itemKey(action.change.type, action.change.item.id)) && typeof onInspect === 'function';
    const target = action.kind === 'revision' || action.change.change !== 'removed' ? action.revision : action.beforeRevision;
    button.disabled = !current && !(availableRevisions.has(target) && typeof onReplay === 'function');
    button.setAttribute('aria-label', actionLabel(action));
    button.setAttribute('title', actionLabel(action));
  }

  function historyCard(entry) {
    const element = html(document, 'li', undefined, 'diagram-change');
    element.setAttribute('data-revision', entry.revision);
    const heading = html(document, 'div', undefined, 'change-heading');
    const replayButton = html(document, 'button', `Revision ${entry.revision}`, 'change-revision');
    replayButton.setAttribute('type', 'button');
    const revisionAction = { kind: 'revision', revision: entry.revision };
    actions.set(replayButton, revisionAction);
    const buttons = [[replayButton, revisionAction]];
    heading.append(replayButton, timeLabel(document, entry.at));
    element.append(heading);
    if (entry.baseline) {
      element.classList.add('history-baseline');
      element.append(html(document, 'p',
        `History baseline · ${entry.graph.nodes.length} components, ${entry.graph.edges.length} connections. Earlier changes are unavailable.`,
        'change-baseline-note'));
      return { element, buttons };
    }
    const totals = Object.keys(CHANGES).map(kind => {
      const count = entry.changes.filter(change => change.change === kind).length;
      return count ? `${count} ${kind}` : '';
    }).filter(Boolean).join(' · ');
    element.append(html(document, 'p', totals, 'change-totals'));
    if (entry.revision > entry.beforeRevision + 1) {
      element.append(html(document, 'p', `Net changes since revision ${entry.beforeRevision}; intervening revisions are unavailable.`, 'change-gap'));
    }
    const tiles = html(document, 'ul', undefined, 'change-tiles');
    tiles.setAttribute('aria-label', `Changes in revision ${entry.revision}`);
    for (const change of entry.changes.slice(0, LIMITS.tiles)) {
      const tile = html(document, 'li', undefined, 'change-tile');
      tile.dataset.change = change.change;
      tile.dataset.kind = change.type === 'edge' ? 'module' : change.item.kind;
      tile.dataset.type = change.type;
      const button = html(document, 'button', undefined, 'change-item');
      button.setAttribute('type', 'button');
      const [symbol, name] = CHANGES[change.change];
      const label = html(document, 'span', undefined, 'change-item-copy');
      label.append(html(document, 'span', `${symbol} ${name}`, 'change-verb'));
      label.append(html(document, 'strong', change.label));
      if (change.type === 'edge') label.append(html(document, 'span', 'Connection', 'change-item-kind'));
      button.append(miniature(document, change), label);
      const action = { kind: 'item', change, revision: entry.revision, beforeRevision: entry.beforeRevision };
      actions.set(button, action);
      buttons.push([button, action]);
      tile.append(button);
      tiles.append(tile);
    }
    element.append(tiles);
    if (entry.changes.length > LIMITS.tiles) {
      element.append(html(document, 'p', `+ ${entry.changes.length - LIMITS.tiles} more changes in this revision`, 'change-overflow'));
    }
    return { element, buttons };
  }

  function history(snapshot, replay) {
    const nextIdentity = JSON.stringify([snapshot.projectId, snapshot.sessionId]);
    // Session IDs can be reused after retention eviction or a daemon restart.
    // Forget disappeared sessions before considering a later appearance.
    if (Array.isArray(snapshot.sessions)) {
      const retained = new Set(snapshot.sessions.map(session => session.id));
      for (const [key, cached] of histories) {
        if (cached.projectId === snapshot.projectId && !retained.has(cached.sessionId)) histories.delete(key);
      }
    }
    let cache = histories.get(nextIdentity);
    const reset = cache && revision(snapshot.graph?.revision) && snapshot.graph.revision < cache.lastRevision;
    if (reset) { histories.delete(nextIdentity); cache = null; }
    const switched = identity !== nextIdentity || !cache;
    identity = nextIdentity;
    cache ??= {
      projectId: snapshot.projectId, sessionId: snapshot.sessionId, lastRevision: -1,
      frames: new Map(), visible: [], currentGraph: null,
    };
    const frames = cache.frames;
    histories.delete(identity);
    histories.set(identity, cache);
    while (histories.size > LIMITS.sessions) histories.delete(histories.keys().next().value);
    const currentRevision = snapshot.graph?.revision;
    if (revision(currentRevision)) cache.lastRevision = currentRevision;
    const provided = new Map(list(snapshot.history).slice(-LIMITS.frames)
      .filter(frame => revision(frame?.revision) && frame.graph && frame.revision <= currentRevision)
      .map(frame => [frame.revision, frame]));
    if (revision(currentRevision)) provided.set(currentRevision, {
      revision: currentRevision, graph: snapshot.graph, at: provided.get(currentRevision)?.at ?? null,
    });
    const nextAvailable = JSON.stringify([...provided.keys()].sort((a, b) => a - b));
    const availabilityChanged = switched || nextAvailable !== availableSignature;
    if (availabilityChanged) {
      availableSignature = nextAvailable;
      availableRevisions = new Set(provided.keys());
    }
    const changed = new Set();
    const check = new Set([currentRevision]);
    const cachedCurrent = frames.get(currentRevision);
    const sameCurrent = cachedCurrent && sameGraph(cachedCurrent.graph, snapshot.graph);
    let projectionChanged = cachedCurrent && !sameCurrent;
    for (const [number, frame] of provided) {
      if (!frames.has(number) || frames.get(number).stamp !== frameStamp(frame) || switched) check.add(number);
    }
    // A hook-only snapshot may be freshly parsed JSON, so reference equality
    // cannot identify unchanged history. Inspect only displayed items, by
    // cached index, to honor privacy reprojection without traversing all frames.
    for (const entry of cache.visible) {
      for (const change of (entry.changes ?? []).slice(0, LIMITS.tiles)) {
        const number = change.change === 'removed' ? entry.beforeRevision : entry.revision;
        const cached = frames.get(number), raw = provided.get(number)?.graph;
        if (!cached || !raw || check.has(number)) continue;
        const collection = change.type === 'node' ? 'nodes' : 'edges';
        const index = cached.positions[collection].get(change.item.id);
        if (!sameItem(cached.graph[collection][index], raw[collection]?.[index], change.type === 'node' ? NODE_FIELDS : EDGE_FIELDS)) {
          check.add(number);
          projectionChanged = true;
          continue;
        }
        if (change.type === 'edge') {
          for (const id of [change.item.source, change.item.target]) {
            const position = cached.positions.nodes.get(id);
            if (!sameItem(cached.graph.nodes[position], raw.nodes?.[position], NODE_FIELDS)) {
              check.add(number);
              projectionChanged = true;
            }
          }
        }
      }
    }
    // Label projection applies across history. Recheck it once when an actual
    // displayed change is detected, including when the live graph is empty.
    if (projectionChanged) for (const number of provided.keys()) check.add(number);
    // Refresh the preceding projection before comparing a newly arrived frame.
    // This is one adjacent graph, not a replay of every historical comparison.
    const incomingOrder = [...provided.keys()].sort((a, b) => a - b);
    incomingOrder.forEach((number, index) => {
      if (!frames.has(number) && index > 0) check.add(incomingOrder[index - 1]);
    });
    for (const [number, frame] of provided) {
      const previous = frames.get(number);
      const at = timestamp(frame.at) ?? previous?.at ?? null;
      const different = !previous || check.has(number)
        && !(number === currentRevision ? sameCurrent : sameGraph(previous.graph, frame.graph));
      if (different || previous.at !== at) changed.add(number);
      if (different) {
        const graph = semanticGraph(frame.graph);
        frames.set(number, {
          revision: number, at, graph, stamp: frameStamp(frame),
          positions: {
            nodes: new Map(graph.nodes.map((item, index) => [item.id, index])),
            edges: new Map(graph.edges.map((item, index) => [item.id, index])),
          },
        });
      } else {
        previous.at = at;
        previous.stamp = frameStamp(frame);
      }
    }
    const currentGraph = frames.get(currentRevision)?.graph;
    const currentChanged = switched || cache.currentGraph !== currentGraph;
    if (currentChanged) {
      currentItems = new Set([
        ...list(currentGraph?.nodes).map(item => itemKey('node', item.id)),
        ...list(currentGraph?.edges).map(item => itemKey('edge', item.id)),
      ]);
      cache.currentGraph = currentGraph;
    }
    $('sidebar-change-note').textContent = replay
      ? 'Newest changes first. This history stays live while you replay a revision.'
      : 'Newest changes first. Select a shape to inspect it, or a revision to replay.';
    if (!switched && !changed.size && !availabilityChanged && !currentChanged) return;
    const ordered = [...frames.values()].sort((a, b) => a.revision - b.revision);
    for (const older of ordered.splice(0, Math.max(0, ordered.length - LIMITS.frames))) frames.delete(older.revision);
    const entries = [];
    for (let index = 0; index < ordered.length; index++) {
      const frame = ordered[index];
      const previous = ordered[index - 1];
      if (frame.beforeGraph !== previous?.graph || frame.entryGraph !== frame.graph || frame.entryAt !== frame.at) {
        frame.beforeGraph = previous?.graph;
        frame.entryGraph = frame.graph;
        frame.entryAt = frame.at;
        if (!previous) {
          frame.entry = frame.graph.nodes.length || frame.graph.edges.length
            ? { revision: frame.revision, at: frame.at, graph: frame.graph, baseline: true } : null;
        } else {
          const changes = differences(previous.graph, frame.graph);
          frame.entry = changes.length
            ? { revision: frame.revision, at: frame.at, beforeRevision: previous.revision, changes } : null;
        }
      }
      if (frame.entry) entries.push(frame.entry);
    }
    const visible = entries.slice(-LIMITS.cards).reverse();
    cache.visible = visible;
    const keys = new Set();
    const rows = [];
    for (const entry of visible) {
      const key = JSON.stringify([identity, entry.revision]);
      keys.add(key);
      let card = cards.get(key);
      const signature = card?.entry === entry ? card.signature : renderSignature(entry);
      if (!card || card.signature !== signature) {
        const fresh = !card;
        card?.element.remove();
        card = { ...historyCard(entry), signature };
        cards.set(key, card);
        if (fresh && !switched && !replay && !entry.baseline) card.element.classList.add('is-new-revision');
      }
      card.entry = entry;
      for (const [button, action] of card.buttons) refreshAction(button, action);
      rows.push(card.element);
    }
    for (const [key, card] of cards) if (!keys.has(key)) { card.element.remove(); cards.delete(key); }
    reconcileChildren($('sidebar-change-list'), rows);
    $('sidebar-change-count').textContent = String(visible.filter(entry => !entry.baseline).length);
    $('sidebar-change-empty').hidden = visible.length > 0;
    $('sidebar-change-empty').textContent = 'Shape changes will stack here as this session discovers or changes the architecture.';
  }

  function activate(event) {
    for (let target = event.target; target && target !== $('sidebar-change-list'); target = target.parentElement) {
      const action = actions.get(target);
      if (!action || target.disabled) continue;
      if (action.kind === 'revision') onReplay?.(action.revision);
      else if (action.change.change !== 'removed' && currentItems.has(itemKey(action.change.type, action.change.item.id))
        && typeof onInspect === 'function') onInspect(action.change.type, action.change.item.id);
      else {
        const at = action.change.change === 'removed' ? action.beforeRevision : action.revision;
        if (availableRevisions.has(at)) onReplay?.(at);
      }
      return;
    }
  }
  $('sidebar-change-list').addEventListener('click', activate);

  return {
    update(snapshot, { replay = false, theme = 'sketchbook' } = {}) {
      if (destroyed || !snapshot) return;
      $('sidebar-history').dataset.theme = THEMES.includes(theme) ? theme : 'sketchbook';
      hooks(snapshot, replay);
      history(snapshot, replay);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pulse?.cancel();
      $('sidebar-change-list').removeEventListener('click', activate);
      $('sidebar-hook-list').replaceChildren();
      $('sidebar-change-list').replaceChildren();
      histories.clear();
      hookRows.clear();
      cards.clear();
      hookKeys.clear();
      currentItems.clear();
      availableRevisions.clear();
    },
  };
}

function reconcileChildren(parent, children) {
  // Keep existing buttons attached so a status update cannot steal focus.
  children.forEach((child, index) => {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
  });
  while (parent.children.length > children.length) parent.children[parent.children.length - 1].remove();
}
