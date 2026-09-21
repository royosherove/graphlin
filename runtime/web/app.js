import { layoutGraph, LAYOUT_ALGORITHMS } from './layout.js';
import { sketchOutline, sketchDetails, sketchConnection } from './sketch.js';
import { createLiveSidebar } from './sidebar.js';
import { createViewPlatform } from './platform.js';
import { layoutScene, sceneGraph, representedSelection, createToolActivity, activityTargets, sceneActivity } from './scene.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const LIMITS = Object.freeze({ nodes: 500, edges: 1500, activity: 200, hookEvents: 200, history: 100, refs: 32, sessions: 100 });
const ROLES = ['client', 'service', 'datastore', 'queue', 'external', 'module', 'function', 'class', 'interface', 'event', 'configuration', 'package',
  'method', 'namespace', 'enum', 'type_alias', 'variable', 'file', 'directory', 'project', 'unknown', 'group'];
export const SHAPE_NAMES = Object.freeze({
  rounded_rect: 'Rounded rectangle', rect: 'Rectangle', cylinder: 'Cylinder', cloud: 'Cloud',
  diamond: 'Diamond', group: 'Group', browser: 'Browser', component: 'Component',
  queue: 'Queue', hexagon: 'Hexagon', class_box: 'Class box', interface_box: 'Interface box',
  document: 'Document', parallelogram: 'Parallelogram', folder: 'Folder',
});
const SHAPES = Object.keys(SHAPE_NAMES);
export const THEME_NAMES = Object.freeze({
  sketchbook: 'Sketchbook', ocean: 'Ocean', forest: 'Forest', sunset: 'Sunset',
  berry: 'Berry', sepia: 'Sepia', blueprint: 'Blueprint dark', midnight: 'Midnight dark',
});
const THEMES = Object.keys(THEME_NAMES);
const RELATIONS = ['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on'];
const CLASSIFICATIONS = ['pending', 'accepted', 'tentative', 'abstained', 'stale'];
const EVIDENCE = ['proposed', 'observed', 'verified', 'removed'];
const VALIDITY = ['current', 'stale', 'retracted'];
const INTERPRETATION_BASES = ['jev_interpretation', 'decision_interpretation'];
const ACTIVITY = ['idle', 'pending', 'running', 'failed', 'interrupted', 'unknown'];
const EVENT_STATES = ['pending', 'succeeded', 'failed', 'interrupted', 'unresolved', 'observed'];
const CLASSIFIERS = ['ready', 'metadata_only', 'missing_key', 'paused', 'unavailable', 'timeout', 'demo'];
const ROLE_SHAPES = {
  client: 'browser', service: 'component', datastore: 'cylinder', queue: 'queue', external: 'cloud',
  module: 'rect', function: 'hexagon', class: 'class_box', interface: 'interface_box',
  event: 'document', configuration: 'parallelogram', package: 'folder',
  method: 'hexagon', namespace: 'folder', enum: 'class_box', type_alias: 'interface_box',
  variable: 'rect', file: 'document', directory: 'folder', project: 'folder', unknown: 'rect', group: 'group',
};
const PROBABILITIES = ['supportProbability', 'roleProbability', 'roleConfidence', 'missingContextProbability'];
const NODE_WIDTH = 190;
const NODE_HEIGHT = 104;
const EDGE_LANE_GAP = 36;
const EDGE_RELATION_ORDER = ['calls', 'writes', 'depends_on', 'reads', 'publishes', 'consumes',
  'imports', 'references', 'member_of', 'hosted_by', 'contains', 'unknown'];
const LAYOUT_NAMES = {
  hierarchy: 'Hierarchy top-down', dependency: 'Dependency left-right', grouped: 'Group by type',
  circular: 'Circular', grid: 'Grid', original: 'Original', force: 'Force-directed',
};
const MAX_VIEWS = 32;
const MAX_EFFECTS = 16;
const MAX_SKETCHES = 512;
const MIN_ZOOM = .000001;
const MAX_ZOOM = 4;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const token = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1e9) : 0;
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const coordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;

export function safeText(value, max = 180) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : '';
}

function identifier(value) { return safeText(value, 180); }
function readable(value) { return value.replaceAll('_', ' '); }
function upperFirst(value) { return value ? value[0].toUpperCase() + value.slice(1) : ''; }
function validTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? timestamp : null;
}
function shortId(value) { return value.length > 19 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value; }
function clip(value, size) { return value.length > size ? `${value.slice(0, size - 1)}…` : value; }
function hashId(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function createSketchCache(draw = sketchOutline) {
  const entries = new Map();
  return {
    paths(shape, id) {
      const key = JSON.stringify([shape, id]);
      let paths = entries.get(key);
      if (paths) entries.delete(key);
      else paths = Object.freeze(draw(shape, id).slice(0, 2));
      entries.set(key, paths);
      while (entries.size > MAX_SKETCHES) entries.delete(entries.keys().next().value);
      return paths;
    },
    clear() { entries.clear(); },
  };
}

export function createPresentation() {
  return { algorithm: 'hierarchy', auto: true, theme: 'sketchbook', positions: new Map(), shapes: new Map(), signature: '', camera: null };
}

export function presentationKey(snapshot, replayFrame = null) {
  return JSON.stringify([snapshot.projectId, snapshot.sessionId, replayFrame ? `revision:${replayFrame.revision}` : 'live']);
}

export function layoutSignature(graph, algorithm) {
  // Parallel relation types, labels, confidence and activity do not change the
  // structural layout. Legacy diamonds are the only larger shape envelope.
  const nodes = graph.nodes.map(node => [node.id, node.kind, node.shape === 'diamond',
    ...(algorithm === 'original' ? [node.x, node.y] : [])]).sort((a, b) => a[0].localeCompare(b[0]));
  const pairs = [...new Set(graph.edges.map(edge => JSON.stringify([edge.source, edge.target])))].sort();
  return JSON.stringify([algorithm, nodes, pairs]);
}

function stagedPositions(nodes, supplied) {
  const positions = new Map();
  for (const node of nodes) {
    const point = supplied.get(node.id);
    // These positions are generated locally. Staging can extend beyond the
    // canonical coordinate intake bound and must not discard that position on
    // the next metadata-only snapshot.
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) positions.set(node.id, { x: point.x, y: point.y });
  }
  const missing = nodes.filter(node => !positions.has(node.id)).sort((a, b) => a.id.localeCompare(b.id));
  // A disjoint shelf beyond all placed nodes also handles bounded layout
  // engines returning fewer nodes than the viewer admits.
  const startX = positions.size ? Math.max(...[...positions.values()].map(point => point.x)) + NODE_WIDTH + 80 : 0;
  const startY = positions.size ? Math.min(...[...positions.values()].map(point => point.y)) : 0;
  const columns = Math.max(1, Math.ceil(Math.sqrt(missing.length)));
  missing.forEach((node, index) => positions.set(node.id, {
    x: startX + index % columns * (NODE_WIDTH + 80),
    y: startY + Math.floor(index / columns) * (NODE_HEIGHT + 80),
  }));
  return positions;
}

export function displayShape(node, overrides) {
  const override = overrides.get(node.id);
  return override === 'automatic' ? ROLE_SHAPES[node.kind] : token(override, SHAPES, node.shape);
}

export function projectPresentation(graph, view, { arrange = false, layout = layoutGraph } = {}) {
  const signature = layoutSignature(graph, view.algorithm);
  if (view.algorithm === 'original') {
    view.positions = new Map(graph.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  } else if (arrange || (view.auto && signature !== view.signature)) {
    const positions = layout({
      nodes: graph.nodes.map(({ id, kind, x, y }) => ({ id, kind, x, y })),
      edges: graph.edges.map(({ id, source, target }) => ({ id, source, target })),
    }, { algorithm: view.algorithm, nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, gapX: 80, gapY: 80 });
    view.positions = stagedPositions(graph.nodes, positions instanceof Map ? positions : new Map());
  } else view.positions = stagedPositions(graph.nodes, view.positions);
  view.signature = signature;
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, ...view.positions.get(node.id), shape: displayShape(node, view.shapes) })) };
}

export function liveNodeChanges(previous, next, eligible) {
  if (!eligible || !previous || !next) return { added: [], removed: [] };
  const before = new Set(previous.nodes.map(node => node.id));
  const after = new Set(next.nodes.map(node => node.id));
  return {
    added: next.nodes.filter(node => !before.has(node.id)).map(node => node.id),
    removed: previous.nodes.filter(node => !after.has(node.id)).map(node => node.id),
  };
}

export function filterDiagram(graph, query = '', kinds = null) {
  if (!query && kinds === null) return graph;
  const needle = query.toLowerCase();
  const nodes = graph.nodes.filter(node => (kinds === null || kinds.has(node.kind)) && node.label.toLowerCase().includes(needle));
  const visible = new Set(nodes.map(node => node.id));
  return { ...graph, nodes, edges: graph.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)) };
}

function isSearchTypingTarget(target) {
  for (let element = target; element; element = element.parentElement) {
    if (['input', 'textarea', 'select', 'dialog'].includes(element.tagName?.toLowerCase()) ||
      element.isContentEditable || ['textbox', 'combobox', 'searchbox'].includes(element.getAttribute?.('role')) ||
      ['true', '', 'plaintext-only'].includes(element.getAttribute?.('contenteditable'))) return true;
  }
  return false;
}

function nodeTitleWidth(shapeName) {
  return { queue: 132, component: 142, parallelogram: 144, diamond: 140 }[shapeName] || 158;
}

export function nodeTitleLines(label, shapeName) {
  const width = nodeTitleWidth(shapeName);
  // Conservative advances for a 14px title, independent of font availability.
  // The title's SVG viewport also clips any wider fallback glyphs.
  const measure = text => [...text].reduce((sum, char) => sum +
    (/[^\x20-\x7e]|[MWmw@%&]/.test(char) ? 16 : /[A-Z]/.test(char) ? 11 : /[il.,' :;]/.test(char) ? 5 : 9), 0);
  const words = safeText(label).replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const last = lines.length - 1;
    const candidate = lines[last] ? `${lines[last]} ${word}` : word;
    if (measure(candidate) <= width) { lines[last] = candidate; continue; }
    if (lines[last]) lines.push('');
    for (const char of word) {
      const index = lines.length - 1;
      if (measure(lines[index] + char) > width) lines.push(char);
      else lines[index] += char;
    }
  }
  if (lines.length > 2) {
    const characters = [...lines[1]];
    while (measure(characters.join('') + '…') > width) characters.pop();
    lines[1] = characters.join('') + '…';
  }
  return lines.slice(0, 2);
}

export function normalizeConfidence(value) {
  if (probability(value)) return { reportedConfidence: value };
  if (!record(value)) return {};
  const result = {};
  for (const key of PROBABILITIES) if (probability(value[key])) result[key] = value[key];
  if (probability(value.reportedConfidence)) result.reportedConfidence = value.reportedConfidence;
  if (record(value.roleProbabilities)) {
    const roles = {};
    for (const role of [...ROLES, 'unknown']) if (probability(value.roleProbabilities[role])) roles[role] = value.roleProbabilities[role];
    if (Object.keys(roles).length) result.roleProbabilities = roles;
  }
  return result;
}

function normalizeRefs(value, includeExcerpts = true) {
  return array(value).slice(0, LIMITS.refs).filter(record).map(ref => {
    const result = {
      artifactId: identifier(ref.artifactId),
      hash: safeText(ref.hash, 180),
      generation: count(ref.generation),
      eventId: identifier(ref.eventId),
      startLine: count(ref.startLine),
      endLine: count(ref.endLine),
      sourceClass: token(ref.sourceClass, ['source', 'public_intent'], 'unknown'),
      basis: token(ref.basis, INTERPRETATION_BASES, 'unknown'),
    };
    if (record(ref.sourceRef) && ref.sourceRef.type === 'artifact') {
      result.sourceRef = {
        type: 'artifact', artifactId: identifier(ref.sourceRef.artifactId),
        hash: safeText(ref.sourceRef.hash, 180), generation: count(ref.sourceRef.generation),
      };
    } else if (record(ref.sourceRef) && ref.sourceRef.type === 'message') {
      result.sourceRef = {
        type: 'message', messageId: identifier(ref.sourceRef.messageId),
        hash: safeText(ref.sourceRef.hash, 180), contentVersion: count(ref.sourceRef.contentVersion),
      };
    }
    if (includeExcerpts && typeof ref.excerpt === 'string') result.excerpt = safeText(ref.excerpt, 6000);
    return result;
  });
}

function claimFields(value, includeExcerpts) {
  const result = {
    evidenceState: token(value.evidenceState, EVIDENCE, 'proposed'),
    classification: token(value.classification, CLASSIFICATIONS, 'tentative'),
    validity: token(value.validity, VALIDITY, 'stale'),
    sourceRefs: normalizeRefs(value.sourceRefs, includeExcerpts),
  };
  if (probability(value.confidence)) result.confidence = value.confidence;
  else if (record(value.confidence)) {
    const confidence = normalizeConfidence(value.confidence);
    if (Object.keys(confidence).length) result.confidence = confidence;
  }
  return result;
}

export function normalizeGraph(value, { includeExcerpts = true } = {}) {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('invalid_snapshot');
  }
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  for (const raw of value.nodes.slice(0, LIMITS.nodes)) {
    if (!record(raw)) continue;
    const id = identifier(raw.id);
    if (!id || nodeIds.has(id)) continue;
    const kind = token(raw.kind, ROLES, 'module');
    // Normal coordinates are compiler-owned. Corrupt coordinates receive a
    // deterministic, finite fallback without changing any valid node position.
    const fallback = hashId(id);
    nodes.push({
      id, label: safeText(raw.label) || 'Unnamed component', kind,
      shape: token(raw.shape, SHAPES, ROLE_SHAPES[kind]),
      x: coordinate(raw.x) ? raw.x : 40 + (fallback % 4) * 270,
      y: coordinate(raw.y) ? raw.y : 40 + (Math.floor(fallback / 4) % 8) * 170,
      activityState: token(raw.activityState, ACTIVITY, 'unknown'),
      ...claimFields(raw, includeExcerpts),
    });
    nodeIds.add(id);
  }
  for (const raw of value.edges.slice(0, LIMITS.edges)) {
    if (!record(raw)) continue;
    const id = identifier(raw.id);
    const source = identifier(raw.source);
    const target = identifier(raw.target);
    if (!id || edgeIds.has(id) || !nodeIds.has(source) || !nodeIds.has(target) || !RELATIONS.includes(raw.relation)) continue;
    edges.push({
      id, source, target, relation: raw.relation,
      label: safeText(raw.label, 100) || readable(raw.relation),
      ...claimFields(raw, includeExcerpts),
    });
    edgeIds.add(id);
  }
  return { schemaVersion: 1, revision: count(value.revision), nodes, edges };
}

function normalizeCoverage(value) {
  if (typeof value === 'string') return safeText(value, 320);
  if (typeof value === 'number') return count(value);
  if (!record(value)) return null;
  const result = {};
  for (const key of ['gaps', 'unsupported', 'incomplete', 'captured', 'total', 'supported', 'omitted', 'dropped']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = count(value[key]);
  }
  for (const key of ['tools', 'publicIntent', 'manualOnly']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const key of ['mode', 'level']) if (typeof value[key] === 'string') result[key] = safeText(value[key], 80);
  return result;
}

function normalizeActivity(raw) {
  return {
    schemaVersion: 1,
    id: identifier(raw.id),
    projectId: identifier(raw.projectId),
    sessionId: identifier(raw.sessionId),
    agentId: identifier(raw.agentId),
    toolCallId: raw.toolCallId === null ? null : identifier(raw.toolCallId),
    kind: safeText(raw.kind, 60),
    toolCategory: safeText(raw.toolCategory, 50),
    outcome: safeText(raw.outcome, 40),
    at: validTime(raw.at),
    sequence: count(raw.sequence),
    incomplete: raw.incomplete === true,
    label: safeText(raw.label) || 'Observed event',
    state: token(raw.state, EVENT_STATES, 'unresolved'),
  };
}

export function normalizeSnapshot(value, { includeExcerpts = true } = {}) {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.status)) throw new Error('invalid_snapshot');
  const graph = normalizeGraph(value.graph, { includeExcerpts });
  const history = [];
  for (const frame of array(value.history).slice(-LIMITS.history)) {
    if (!record(frame) || !record(frame.graph)) continue;
    try {
      const historicalGraph = normalizeGraph(frame.graph, { includeExcerpts });
      history.push({ revision: historicalGraph.revision, at: validTime(frame.at), graph: historicalGraph });
    } catch { /* An invalid historical frame cannot replace the current graph. */ }
  }
  const sessions = [];
  const sessionIds = new Set();
  for (const session of array(value.sessions).slice(0, LIMITS.sessions)) {
    if (!record(session)) continue;
    const id = identifier(session.id);
    if (!id || sessionIds.has(id)) continue;
    sessions.push({ id, label: safeText(session.label, 120) || `Session ${shortId(id)}` });
    sessionIds.add(id);
  }
  const sessionId = value.sessionId === null ? null : identifier(value.sessionId);
  if (sessionId && !sessionIds.has(sessionId)) sessions.push({ id: sessionId, label: `Session ${shortId(sessionId)}` });
  return {
    schemaVersion: 1,
    projectId: identifier(value.projectId),
    sessionId,
    mode: token(value.mode, ['live', 'demo', 'replay'], 'live'),
    paused: value.paused === true,
    sessions,
    graph,
    activity: array(value.activity).slice(-LIMITS.activity).filter(record).map(normalizeActivity),
    ...(Array.isArray(value.hookEvents) ? {
      hookEvents: value.hookEvents.slice(-LIMITS.hookEvents).filter(record).map(event => ({
        ...normalizeActivity(event), receipt: count(event.receipt),
      })),
    } : {}),
    history,
    status: {
      connection: safeText(value.status.connection, 80),
      classifier: token(value.status.classifier, CLASSIFIERS, 'unavailable'),
      coverage: normalizeCoverage(value.status.coverage),
      dropped: count(value.status.dropped),
      pending: count(value.status.pending),
      calls: count(value.status.calls),
    },
  };
}

export function sanitizedExport(value) {
  // Reproject the export endpoint, including historical graphs. Display
  // permission does not imply that source excerpts should leave the viewer.
  const result = normalizeSnapshot(value, { includeExcerpts: false });
  for (const event of result.activity) if (event.at !== null) event.at = new Date(event.at).toISOString();
  for (const event of array(result.hookEvents)) if (event.at !== null) event.at = new Date(event.at).toISOString();
  for (const frame of result.history) if (frame.at !== null) frame.at = new Date(frame.at).toISOString();
  return result;
}

export function coverageSummary(coverage, dropped = 0) {
  let label = 'Coverage not reported';
  if (typeof coverage === 'string' && coverage) label = `Coverage: ${readable(coverage)}`;
  else if (typeof coverage === 'number') label = coverage ? `${coverage} coverage gaps` : 'No reported coverage gaps';
  else if (record(coverage)) {
    if (coverage.manualOnly) label = 'Manual control only';
    else if (coverage.tools && coverage.publicIntent) label = 'Tools + public intent';
    else if (coverage.tools) label = 'Tools only';
    else if (coverage.mode || coverage.level) label = `Coverage: ${readable(coverage.mode || coverage.level)}`;
    const gaps = count(coverage.gaps ?? coverage.unsupported) + count(coverage.incomplete) + count(coverage.omitted);
    if (gaps) label += ` · ${gaps} reported gaps`;
    else if (own(coverage, 'gaps')) label += ' · no reported gaps';
  }
  return dropped ? `${label} · ${dropped} dropped` : label;
}

export function claimSummary(claim) {
  const refs = claim.sourceRefs || [];
  if (claim.validity === 'retracted' || claim.evidenceState === 'removed') {
    return { tone: 'stale', label: 'Support retracted', explanation: 'The recorded support was retracted. This claim is retained here for context or replay.' };
  }
  if (claim.validity === 'stale' || claim.classification === 'stale') {
    return { tone: 'stale', label: 'Evidence stale', explanation: 'The backing evidence is no longer current. This interpretation needs reconciliation with the current artifact version.' };
  }
  if (claim.basis === 'parsed' && refs.length && !refs.some(ref => ref.sourceClass === 'public_intent')) {
    return { tone: 'observed', label: 'Parsed source', explanation: 'A local source parser identified this structure. Source structure does not establish execution or runtime connectivity.' };
  }
  if (claim.basis === 'metadata') {
    return { tone: 'proposed', label: 'Filesystem scope', explanation: 'An observed filesystem scope. Its responsibility and runtime role are unknown.' };
  }
  if (claim.basis === 'decision' && claim.classification === 'accepted' && refs.length) {
    return { tone: 'observed', label: 'Supported interpretation', explanation: 'The model records a supported interpretation of the referenced evidence. This does not establish runtime hosting or execution.' };
  }
  if (claim.evidenceState === 'proposed' || (refs.length && refs.every(ref => ref.sourceClass === 'public_intent'))) {
    return { tone: 'proposed', label: 'Proposed', explanation: 'This is a proposal or stated intent. It does not establish that a component exists or that a change completed.' };
  }
  if (claim.classification !== 'accepted') {
    return { tone: 'proposed', label: upperFirst(claim.classification), explanation: 'The code interpretation is uncertain or incomplete. Inspect the evidence before relying on this claim.' };
  }
  if (!refs.length || refs.some(ref => !INTERPRETATION_BASES.includes(ref.basis) || ref.sourceClass === 'unknown')) {
    return { tone: 'proposed', label: 'Provenance incomplete', explanation: 'This snapshot does not provide enough provenance to establish the basis of this claim.' };
  }
  const generic = refs.some(ref => ref.basis === 'decision_interpretation');
  return { tone: 'observed', label: generic ? 'Decision interpretation' : 'Code evidence',
    explanation: `${generic ? 'A decision provider' : 'Jev'} interpreted approved source evidence as supporting this claim. Code or configuration can describe a dependency without proving that it runs or connects successfully.` };
}

export function edgeLanes(edges) {
  const groups = new Map();
  const pairCounts = new Map();
  for (const edge of edges) {
    const pair = JSON.stringify([edge.source, edge.target].sort());
    pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    const key = JSON.stringify([edge.source, edge.target, edge.relation]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  const lanes = new Map();
  for (const siblings of groups.values()) {
    siblings.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    siblings.forEach((edge, index) => {
      const pair = JSON.stringify([edge.source, edge.target].sort());
      if (pairCounts.get(pair) === 1) {
        lanes.set(edge.id, 0);
        return;
      }
      // Parallel relations retain fixed slots; reverse directions occupy the
      // opposite side. An isolated relation uses a direct connection.
      const direction = edge.source <= edge.target ? 1 : -1;
      const relation = Math.max(0, EDGE_RELATION_ORDER.indexOf(edge.relation));
      lanes.set(edge.id, direction * (.5 + relation + index * EDGE_RELATION_ORDER.length));
    });
  }
  return lanes;
}

export function graphEdgeRoutes(graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const lanes = edgeLanes(graph.edges);
  const routes = new Map();
  const pairWidths = new Map();
  for (const edge of graph.edges) {
    const pair = JSON.stringify([edge.source, edge.target].sort());
    pairWidths.set(pair, Math.max(pairWidths.get(pair) || 0, edgeLabelWidth(edge.label)));
  }
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    const lane = lanes.get(edge.id);
    const route = routeEdge(source, target, lane);
    route.labelWidth = edgeLabelWidth(edge.label);
    route.labelHeight = 26;
    const pair = JSON.stringify([edge.source, edge.target].sort());
    const gap = Math.hypot(route.end.x - route.start.x, route.end.y - route.start.y);
    if (source.id !== target.id && gap < pairWidths.get(pair) + 26) {
      // A short gap cannot fit a readable label between node boundaries.
      // Put labels outside the pair's silhouette on distinct, compact rails;
      // the arrow remains straight when this is the pair's only relationship.
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const length = Math.hypot(dx, dy) || 1;
      const direction = source.id <= target.id ? 1 : -1;
      const normal = { x: -dy / length * direction, y: dx / length * direction };
      const angle = route.angle * Math.PI / 180;
      const labelExtent = route.labelWidth / 2 * Math.abs(Math.cos(angle) * normal.x + Math.sin(angle) * normal.y)
        + route.labelHeight / 2 * Math.abs(-Math.sin(angle) * normal.x + Math.cos(angle) * normal.y);
      const nodeExtent = Math.abs(normal.x) * NODE_WIDTH / 2 + Math.abs(normal.y) * NODE_HEIGHT / 2;
      const offset = (lane > 0 ? 1 : -1) * (nodeExtent + labelExtent + 8 + Math.max(0, Math.abs(lane) - .5) * EDGE_LANE_GAP);
      route.x = (source.x + target.x + NODE_WIDTH) / 2 + normal.x * offset;
      route.y = (source.y + target.y + NODE_HEIGHT) / 2 + normal.y * offset;
      const leaderX = route.midpoint.x - route.x;
      const leaderY = route.midpoint.y - route.y;
      const localX = Math.cos(angle) * leaderX + Math.sin(angle) * leaderY;
      const localY = -Math.sin(angle) * leaderX + Math.cos(angle) * leaderY;
      const fraction = Math.min(
        localX === 0 ? Infinity : route.labelWidth / 2 / Math.abs(localX),
        localY === 0 ? Infinity : route.labelHeight / 2 / Math.abs(localY),
      );
      if (Number.isFinite(fraction)) {
        route.leader = `M ${route.midpoint.x} ${route.midpoint.y} L ${route.x + leaderX * fraction} ${route.y + leaderY * fraction}`;
      }
    }
    routes.set(edge.id, route);
  }
  return routes;
}

function edgeLabelWidth(label) { return Math.max(42, clip(label, 28).length * 6.5 + 16); }

export function graphBounds(graph, routes = graphEdgeRoutes(graph)) {
  if (!graph.nodes.length) return { x: 0, y: 0, width: 920, height: 510 };
  let minX = Math.min(...graph.nodes.map(node => node.x));
  let minY = Math.min(...graph.nodes.map(node => node.y));
  let maxX = Math.max(...graph.nodes.map(node => node.x + (node.width || NODE_WIDTH)));
  let maxY = Math.max(...graph.nodes.map(node => node.y + (node.height || NODE_HEIGHT)));
  for (const edge of graph.edges) {
    const route = routes.get(edge.id);
    if (!route) continue;
    const angle = route.angle * Math.PI / 180;
    const halfWidth = route.labelWidth / 2;
    const halfHeight = route.labelHeight / 2;
    const labelWidth = Math.abs(Math.cos(angle)) * halfWidth + Math.abs(Math.sin(angle)) * halfHeight;
    const labelHeight = Math.abs(Math.sin(angle)) * halfWidth + Math.abs(Math.cos(angle)) * halfHeight;
    minX = Math.min(minX, route.bounds.minX, route.x - labelWidth);
    minY = Math.min(minY, route.bounds.minY, route.y - labelHeight);
    maxX = Math.max(maxX, route.bounds.maxX, route.x + labelWidth);
    maxY = Math.max(maxY, route.bounds.maxY, route.y + labelHeight);
  }
  return {
    x: minX - 64, y: minY - 64,
    width: Math.max(400, maxX - minX + 128),
    height: Math.max(280, maxY - minY + 128),
  };
}

export function fitViewport(bounds, size = { width: 920, height: 510 }) {
  const width = Number.isFinite(size?.width) && size.width > 0 ? size.width : 920;
  const height = Number.isFinite(size?.height) && size.height > 0 ? size.height : 510;
  const zoom = Math.min(MAX_ZOOM, width / bounds.width, height / bounds.height);
  const viewport = { width: width / zoom, height: height / zoom };
  viewport.x = bounds.x + (bounds.width - viewport.width) / 2;
  viewport.y = bounds.y + (bounds.height - viewport.height) / 2;
  return { viewport, zoom };
}

function cameraGraphSignature(graph, algorithm) {
  // Tool progress is independent of architecture. Repeated snapshots, live
  // activity, evidence excerpts and confidence updates must not move the camera.
  const nodes = graph.nodes.map(node => [
    node.id, node.label, node.kind, node.shape, node.x, node.y,
    node.evidenceState, node.classification, node.validity,
  ]).sort((a, b) => a[0].localeCompare(b[0]));
  const edges = graph.edges.map(edge => [
    edge.id, edge.source, edge.target, edge.label, edge.relation,
    edge.evidenceState, edge.classification, edge.validity,
  ]).sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([algorithm, nodes, edges]);
}

function combinedBounds(first, second) {
  const x = Math.min(first.x, second.x), y = Math.min(first.y, second.y);
  return {
    x, y,
    width: Math.max(first.x + first.width, second.x + second.width) - x,
    height: Math.max(first.y + first.height, second.y + second.height) - y,
  };
}

function curveRoute(points, normal) {
  const [start, first, second, end] = points;
  const round = value => Number(value.toFixed(3));
  const midpoint = {
    x: round((start.x + 3 * first.x + 3 * second.x + end.x) / 8),
    y: round((start.y + 3 * first.y + 3 * second.y + end.y) / 8),
  };
  const x = round(midpoint.x - normal.x * 9);
  const y = round(midpoint.y - normal.y * 9);
  const tangentX = first.x - start.x + 2 * (second.x - first.x) + end.x - second.x;
  const tangentY = first.y - start.y + 2 * (second.y - first.y) + end.y - second.y;
  let angle = Math.atan2(tangentY, tangentX) * 180 / Math.PI;
  if (angle >= 90) angle -= 180;
  if (angle < -90) angle += 180;
  const cubic = points.map(point => [round(point.x), round(point.y)]);
  const coordinates = cubic.map(point => point.join(' '));
  return {
    d: `M ${coordinates[0]} C ${coordinates.slice(1).join(' ')}`,
    points: cubic,
    x, y, angle: round(angle), start, end, midpoint,
    // The control hull contains the complete cubic, including its outer arcs.
    bounds: {
      minX: Math.min(...points.map(point => point.x)),
      minY: Math.min(...points.map(point => point.y)),
      maxX: Math.max(...points.map(point => point.x)),
      maxY: Math.max(...points.map(point => point.y)),
    },
  };
}

function nodePort(center, direction, normal, offset, shapeName, width = NODE_WIDTH, height = NODE_HEIGHT) {
  const reach = Math.min(
    direction.x === 0 ? Infinity : width / 2 / Math.abs(direction.x),
    direction.y === 0 ? Infinity : height / 2 / Math.abs(direction.y),
  );
  const x = direction.x * reach + normal.x * offset;
  const y = direction.y * reach + normal.y * offset;
  const scale = Math.min(
    x === 0 ? Infinity : width / 2 / Math.abs(x),
    y === 0 ? Infinity : height / 2 / Math.abs(y),
  );
  const polygons = {
    diamond: [[95, -12], [204, 52], [95, 116], [-14, 52]],
    component: [[10, 0], [190, 0], [190, 104], [10, 104], [10, 85], [0, 85],
      [0, 68], [10, 68], [10, 35], [0, 35], [0, 18], [10, 18]],
    hexagon: [[23, 0], [167, 0], [190, 52], [167, 104], [23, 104], [0, 52]],
    parallelogram: [[22, 0], [190, 0], [168, 104], [0, 104]],
    document: [[0, 0], [167, 0], [190, 23], [190, 104], [0, 104]],
    folder: [[0, 10], [66, 10], [78, 0], [190, 0], [190, 104], [0, 104]],
  };
  const polygon = polygons[shapeName];
  let reachScale = scale;
  if (polygon) {
    let outerExit = 0;
    const cross = (ax, ay, bx, by) => ax * by - ay * bx;
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index], b = polygon[(index + 1) % polygon.length];
      const ax = a[0] - NODE_WIDTH / 2, ay = a[1] - NODE_HEIGHT / 2;
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const divisor = cross(x, y, ex, ey);
      if (Math.abs(divisor) < 1e-9) continue;
      const t = cross(ax, ay, ex, ey) / divisor;
      const u = cross(ax, ay, x, y) / divisor;
      if (t >= 0 && u >= 0 && u <= 1) outerExit = Math.max(outerExit, t);
    }
    // Diamonds extend beyond the nominal box. For a concave component outline,
    // use the outermost exit so a tab cannot cover the arrow after a notch.
    if (outerExit > 0) reachScale = outerExit;
  }
  return { x: center.x + x * reachScale, y: center.y + y * reachScale };
}

export function routeEdge(source, target, lane = 0) {
  const limit = LIMITS.edges * EDGE_RELATION_ORDER.length;
  const slot = Number.isFinite(lane) ? Math.max(-limit, Math.min(limit, lane)) : 0;
  if (source.id === target.id) {
    const side = slot < 0 ? -1 : 1;
    const x = source.x + NODE_WIDTH;
    const y = source.y + (side > 0 ? 24 : NODE_HEIGHT - 24);
    const extent = 80 + Math.abs(slot) * EDGE_LANE_GAP;
    const center = { x: source.x + NODE_WIDTH / 2, y: source.y + NODE_HEIGHT / 2 };
    const boundary = point => nodePort(center, { x: point.x - center.x, y: point.y - center.y }, { x: 0, y: 0 }, 0, source.shape);
    return curveRoute([
      boundary({ x, y }),
      { x: x + extent, y: y - side * extent },
      { x: x - 90, y: y - side * extent },
      boundary({ x: x - 80, y: source.y + (side > 0 ? 0 : NODE_HEIGHT) }),
    ], { x: 0, y: side });
  }
  const a = { x: source.x + (source.width || NODE_WIDTH) / 2, y: source.y + (source.height || NODE_HEIGHT) / 2 };
  const b = { x: target.x + (target.width || NODE_WIDTH) / 2, y: target.y + (target.height || NODE_HEIGHT) / 2 };
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const direction = distance ? { x: (b.x - a.x) / distance, y: (b.y - a.y) / distance } : { x: 1, y: 0 };
  const canonicalDirection = source.id <= target.id ? 1 : -1;
  const normal = { x: -direction.y * canonicalDirection, y: direction.x * canonicalDirection };
  const portOffset = Math.max(-36, Math.min(36, slot * 6));
  const start = nodePort(a, direction, normal, portOffset, source.shape, source.width, source.height);
  const end = nodePort(b, { x: -direction.x, y: -direction.y }, normal, portOffset, target.shape, target.width, target.height);
  const arc = slot * EDGE_LANE_GAP * 4 / 3;
  const control = fraction => ({
    x: start.x + (end.x - start.x) * fraction + normal.x * arc,
    y: start.y + (end.y - start.y) * fraction + normal.y * arc,
  });
  return curveRoute([start, control(1 / 3), control(2 / 3), end], normal);
}

export function historyFrames(snapshot) {
  const revisions = new Map();
  for (const frame of snapshot.history) revisions.set(frame.revision, frame);
  // Current evidence may be reprojected without a new semantic revision.
  revisions.set(snapshot.graph.revision, {
    revision: snapshot.graph.revision,
    at: revisions.get(snapshot.graph.revision)?.at ?? null,
    graph: snapshot.graph,
  });
  return [...revisions.values()].sort((a, b) => a.revision - b.revision);
}

export function reconcileReplayFrame(frames, pinned) {
  if (!pinned) return null;
  const currentProjection = frames.find(frame => frame.revision === pinned.revision);
  if (currentProjection) return currentProjection;
  // Keep the historical position after retention eviction, but retain no
  // excerpts that the service can no longer reproject under its display policy.
  return { ...pinned, graph: normalizeGraph(pinned.graph, { includeExcerpts: false }) };
}

export function parseLaunchToken(hash) {
  if (!hash || hash === '#' || hash === '#main') return null;
  if (hash.length > 2048) throw new Error('invalid_launch');
  const fragment = hash.replace(/^#/, '');
  const params = new URLSearchParams(fragment);
  const value = params.has('token') ? params.get('token') : fragment;
  if (params.getAll('token').length > 1 || !/^[A-Za-z0-9_-]{16,512}$/.test(value)) throw new Error('invalid_launch');
  return value;
}

export async function exchangeLaunchToken({ location, history, request }) {
  const hash = location.hash;
  if (!hash || hash === '#' || hash === '#main') return;
  try {
    const launchToken = parseLaunchToken(hash);
    if (launchToken) await request('/api/auth', { method: 'POST', body: JSON.stringify({ token: launchToken }) });
  } finally {
    // Never put the launch token in storage, query strings, logs or later calls.
    history.replaceState(history.state, '', location.pathname + location.search);
  }
}

function html(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function svgElement(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
function formatTime(value, withDate = false) {
  if (value === null) return 'Time unknown';
  return new Intl.DateTimeFormat(undefined, withDate
    ? { dateStyle: 'medium', timeStyle: 'medium' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value);
}

async function readResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) throw new Error('response_too_large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) throw new Error('response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error('response_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const onAbort = () => { clearTimeout(timeout); controller.abort(options.signal?.reason); };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: options.body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: options.body, signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(response.status === 401 || response.status === 403 ? 'auth_required' : 'request_failed');
      error.status = response.status;
      throw error;
    }
    const text = await readResponse(response);
    if (!text.trim()) return null;
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function normalizeConnectionInfo(value) {
  if (!record(value) || !Array.isArray(value.instructions) || typeof value.projectRoot !== 'string') {
    throw new Error('invalid_connection_info');
  }
  const instructions = value.instructions.slice(0, 8).map((instruction, index) => {
    if (!record(instruction) || !Array.isArray(instruction.steps)) throw new Error('invalid_connection_info');
    return {
      id: identifier(instruction.id) || `instruction-${index}`,
      title: safeText(instruction.title, 120) || 'Connection instructions',
      description: safeText(instruction.description, 1200),
      steps: instruction.steps.slice(0, 12).map(step => {
        // Commands must remain complete and exact. Do not clip, construct, run,
        // shell-expand, or silently remove characters from executable text.
        if (!record(step) || typeof step.command !== 'string' || !step.command.trim() ||
          step.command.length > 8192 || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(step.command)) {
          throw new Error('invalid_connection_info');
        }
        return {
          label: safeText(step.label, 160) || 'Command',
          command: step.command,
          description: safeText(step.description, 1200),
        };
      }),
    };
  });
  return {
    projectRoot: safeText(value.projectRoot, 4096),
    mode: token(value.mode, ['live', 'demo', 'replay'], 'live'),
    instructions,
    notes: array(value.notes).slice(0, 12).map(note => safeText(note, 1600)).filter(Boolean),
  };
}

export function friendlyProjectName(projectRoot) {
  return safeText(projectRoot, 4096).replace(/\/+$/, '').split('/').at(-1)?.slice(0, 120) || 'Local project';
}

export function startDashboardInfo({ load = signal => request('/api/about', { signal }) } = {}) {
  const $ = id => document.getElementById(id);
  let closed = false, controller = null, timer = null, pending = null, command = '';
  function render(info) {
    if (!record(info) || typeof info.projectRoot !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(info.version ?? '')) {
      throw new Error('invalid_dashboard_info');
    }
    $('project-path').textContent = safeText(info.projectRoot, 4096) || 'Path unavailable';
    $('project-path').title = $('project-path').textContent;
    $('graphlin-version').textContent = info.version;
    $('version-update-steps').textContent = info.mode === 'demo'
      ? 'Press Ctrl+C in the demo terminal, then run this command to restart the updated offline demo.'
      : 'Press Ctrl+C in the viewer terminal, then run this command. Start a new Claude Code or Codex session after setup finishes.';
    const branch = info.branch;
    $('project-branch').textContent = branch?.status === 'branch'
      ? safeText(branch.name, 1024) || 'Branch unavailable'
      : branch?.status === 'detached' ? `Detached HEAD${branch.commit ? ` · ${safeText(branch.commit, 12)}` : ''}`
      : branch?.status === 'not_git' ? 'Not a Git repository' : 'Branch unavailable';
    $('project-branch').title = $('project-branch').textContent;
    const latest = typeof info.update?.latest === 'string' &&
      /^\d+\.\d+\.\d+$/.test(info.update.latest) ? info.update.latest : null;
    const available = info.update?.status === 'available' && latest;
    $('version-update-indicator').hidden = !available;
    $('version-update-indicator').textContent = available ? `${latest} available` : 'Update available';
    $('version-update-indicator').setAttribute('aria-label', available
      ? `Graphlin ${latest} is available. View update instructions.` : 'View update instructions');
    $('version-update-status').textContent = available ? `Graphlin ${latest} is available`
      : info.update?.status === 'current' ? 'No newer release found'
      : 'Update check unavailable';
    const nextCommand = info.update?.command;
    command = available && typeof nextCommand === 'string' && nextCommand.trim() &&
      nextCommand.length <= 8192 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(nextCommand)
      ? nextCommand : '';
    $('version-update-guide').hidden = !command;
    if ($('version-update-command').textContent !== command) {
      $('version-update-command').textContent = command;
      $('version-update-copy-status').textContent = '';
    }
  }
  function refresh() {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    controller = new AbortController();
    pending = (async () => {
      try {
        await Promise.resolve();
        if (closed) return;
        const info = await load(controller.signal);
        if (!closed) render(info);
      } catch {
        if (!closed) {
          $('project-branch').textContent = 'Branch unavailable';
          if ($('project-path').textContent === 'Checking…') $('project-path').textContent = 'Path unavailable';
          if ($('graphlin-version').textContent === 'Checking…') $('graphlin-version').textContent = 'Version unavailable';
          $('version-update-status').textContent = 'Update check unavailable';
          $('version-update-indicator').hidden = true;
          $('version-update-guide').hidden = true;
          $('version-update-command').textContent = '';
          command = '';
        }
      } finally {
        pending = null;
        controller = null;
        if (!closed) timer = setTimeout(() => { void refresh(); }, 30000);
      }
    })();
    return pending;
  }
  const onCopy = async () => {
    if (closed || !command) return;
    const copied = command;
    try {
      await window.navigator.clipboard.writeText(copied);
      if (!closed && command === copied) $('version-update-copy-status').textContent = 'Copied';
    } catch {
      if (!closed && command === copied) {
        $('version-update-copy-status').textContent = 'Select the command and copy it manually.';
        $('version-update-command').focus();
      }
    }
  };
  $('version-update-copy').addEventListener('click', onCopy);
  return {
    refresh,
    close() {
      closed = true;
      controller?.abort();
      clearTimeout(timer);
      $('version-update-copy').removeEventListener('click', onCopy);
    },
  };
}

export const ORIENTATION_PROMPT = 'Orient yourself in this project: read its main files and explain how the components connect.';

// Observations are not an installation or trust audit. Activity (including
// pre-tool intent) is not a substitute for the server's hook receipt feed.
export function onboardingProgress(snapshot, connection = 'connecting') {
  const demo = snapshot?.mode === 'demo' || snapshot?.status.classifier === 'demo';
  const hooks = array(snapshot?.hookEvents).some(event => event.receipt > 0);
  const calls = (snapshot?.status.calls || 0) > 0;
  const shape = Boolean(snapshot?.graph.nodes.length || array(snapshot?.history).some(frame => frame.graph.nodes.length));
  const classifier = snapshot?.paused ? 'paused' : snapshot?.status.classifier;
  const steps = [
    { id: 'server', state: connection === 'connected' ? 'observed' : 'waiting',
      label: connection === 'connected' ? 'Server connected' : connection === 'connecting' ? 'Connecting to server' : 'Server connection needs attention' },
    { id: 'setup', state: 'unverified', label: 'Agent setup / trust: unverified' },
    { id: 'hooks', state: demo ? 'demo' : hooks ? 'observed' : 'waiting',
      label: demo ? 'Demo hook receipts' : hooks ? 'Hook delivery observed' : 'Waiting for a hook receipt' },
    { id: 'classification', state: demo ? 'demo' : calls ? 'observed' : 'waiting',
      label: demo ? 'Fixture classification' : calls ? 'Classification call observed' : 'Waiting for a classifier call' },
    { id: 'shape', state: demo ? 'demo' : shape ? 'observed' : 'waiting',
      label: demo ? 'Demo shapes' : shape ? 'First shape observed in this session' : 'Waiting for the first shape' },
  ];
  let next;
  if (connection === 'auth') next = ['Open a fresh viewer link from the Graphlin server terminal.', 'Reconnect', 'reconnect'];
  else if (connection !== 'connected') next = [connection === 'connecting'
    ? 'Keep the Graphlin server terminal open while the viewer connects.'
    : 'Check that the Graphlin server is running for this project, then reconnect.', 'Reconnect', 'reconnect'];
  else if (demo) next = ['This is an offline demo. Start a live viewer for your project to connect an agent.', 'How to connect', 'connect'];
  else if (classifier === 'missing_key') next = ['Run graphlin init in this project’s terminal to save a TypeSafe API key at the masked prompt. Then stop and restart the Graphlin server.', 'How to connect', 'connect'];
  else if (classifier === 'metadata_only') next = ['Run graphlin init and choose source mode if you consent to sending locally filtered source and public messages to TypeSafe. Then stop and restart the Graphlin server.', 'How to connect', 'connect'];
  else if (classifier === 'paused') next = ['Resume classification, then ask your agent to read the main project files.', 'Resume classification', 'resume'];
  else if (['unavailable', 'timeout'].includes(classifier)) next = ['Open the classification log for the reported failure. Check the server’s classifier connection, then let your agent read a file again.', 'View classification log', 'diagnostics'];
  else if (!hooks) next = [Array.isArray(snapshot?.hookEvents)
    ? 'Connect your agent to this project and approve its setup prompts. In Codex, review Graphlin in /hooks. Then send the orientation prompt.'
    : 'Restart the updated Graphlin server to see hook receipts. Session activity alone cannot verify hook delivery.', 'How to connect', 'connect'];
  else if (snapshot.status.pending > 0) next = ['Evidence is queued for classification. Follow its progress and any skipped or failed reasons in the log.', 'View classification log', 'diagnostics'];
  else if (!shape) next = ['Send the orientation prompt to your connected agent. If no shape appears, the classification log explains skipped or failed work.', 'View classification log', 'diagnostics'];
  else next = ['Select a shape or arrow to inspect its evidence. Hook delivery does not verify full host trust; classification does not prove runtime success.', 'View classification log', 'diagnostics'];
  return { steps, next: { text: next[0], label: next[1], action: next[2] } };
}

export function startConnectionDialog({ load = () => request('/api/connection-info'), onInfo = () => {} } = {}) {
  const $ = id => document.getElementById(id);
  const dialog = $('connection-dialog');
  const trigger = $('how-to-connect');
  const closeButton = $('connection-dialog-close');
  const retry = $('connection-instructions-retry');
  let opened = false;
  let epoch = 0;
  let returnFocus = null;
  let contentControls = [];
  let disposed = false;

  function clearContent() {
    contentControls = [];
    $('connection-instructions').replaceChildren();
    $('connection-notes').replaceChildren();
    $('connection-notes').hidden = true;
    $('connection-project').hidden = true;
    $('connection-project').textContent = '';
    $('connection-demo').hidden = true;
    $('connection-dialog-intro').textContent = 'Connect Claude Code or Codex with guided npm setup.';
    $('connection-copy-status').textContent = '';
  }
  function renderInfo(info, ticket) {
    const sections = [];
    for (const instruction of info.instructions) {
      const section = html('section', undefined, 'connection-instruction');
      section.append(html('h3', instruction.title));
      if (instruction.description) section.append(html('p', instruction.description));
      const steps = html('ol', undefined, 'connection-steps');
      for (const step of instruction.steps) {
        const item = html('li');
        const heading = html('div', undefined, 'connection-step-heading');
        const copy = html('button', 'Copy');
        copy.type = 'button';
        copy.setAttribute('aria-label', `Copy ${step.label}`);
        const pre = html('pre');
        pre.setAttribute('tabindex', '0');
        pre.setAttribute('aria-label', `${step.label} command`);
        pre.append(html('code', step.command));
        heading.append(html('h4', step.label), copy);
        item.append(heading);
        if (step.description) item.append(html('p', step.description));
        item.append(pre);
        let copying = false;
        copy.addEventListener('click', async () => {
          if (copying || !opened || ticket !== epoch) return;
          copying = true;
          $('connection-copy-status').textContent = '';
          copy.setAttribute('aria-busy', 'true');
          try {
            if (!window.navigator?.clipboard?.writeText) throw new Error('clipboard_unavailable');
            await window.navigator.clipboard.writeText(step.command);
            if (!opened || ticket !== epoch) return;
            copy.textContent = 'Copied';
            $('connection-copy-status').textContent = `${step.label} copied.`;
          } catch {
            if (!opened || ticket !== epoch) return;
            $('connection-copy-status').textContent = 'Copy is unavailable. Select the command text and copy it manually.';
            pre.focus();
          } finally {
            copying = false;
            copy.setAttribute('aria-busy', 'false');
          }
        });
        contentControls.push(copy, pre);
        steps.append(item);
      }
      section.append(steps);
      sections.push(section);
    }
    if (!sections.length) sections.push(html('p', 'No connection instructions are available for this project yet.', 'connection-empty'));
    $('connection-instructions').replaceChildren(...sections);
    $('connection-project').textContent = `Project: ${info.projectRoot}`;
    $('connection-project').hidden = !info.projectRoot;
    $('connection-demo').hidden = info.mode !== 'demo';
    $('connection-demo').textContent = 'This is an offline demo. Start a live viewer in your own project to connect an agent.';
    $('connection-dialog-intro').textContent = info.mode === 'demo'
      ? 'Start Graphlin in your project, then start your agent in a second terminal in that same project.'
      : 'Keep this viewer running. In a second terminal, set up if needed, then start a new agent session for the project below.';
    $('connection-notes').replaceChildren(...info.notes.map(note => html('li', note)));
    $('connection-notes').hidden = !info.notes.length;
  }
  async function loadInstructions() {
    if (!opened || disposed) return;
    const ticket = ++epoch;
    clearContent();
    $('connection-loading').hidden = false;
    $('connection-error').hidden = true;
    $('connection-error').textContent = '';
    retry.hidden = true;
    $('connection-instructions').setAttribute('aria-busy', 'true');
    if (document.activeElement === retry) closeButton.focus();
    try {
      const info = normalizeConnectionInfo(await load());
      if (!opened || disposed || ticket !== epoch) return;
      renderInfo(info, ticket);
      onInfo(info);
    } catch {
      if (!opened || disposed || ticket !== epoch) return;
      $('connection-error').textContent = 'Connection instructions could not be loaded. Check that the local service is running, then retry.';
      $('connection-error').hidden = false;
      retry.hidden = false;
    } finally {
      if (opened && ticket === epoch) {
        $('connection-loading').hidden = true;
        $('connection-instructions').setAttribute('aria-busy', 'false');
      }
    }
  }
  function finishClose() {
    if (!opened) return;
    opened = false;
    epoch++;
    clearContent();
    $('connection-loading').hidden = true;
    $('connection-error').hidden = true;
    retry.hidden = true;
    $('connection-instructions').setAttribute('aria-busy', 'false');
    const destination = returnFocus && document.body.contains(returnFocus) && !returnFocus.disabled ? returnFocus : trigger;
    returnFocus = null;
    if (!disposed) destination.focus({ preventScroll: true });
  }
  function closeDialog() {
    if (!opened) return;
    dialog.close();
    finishClose();
  }
  function openDialog() {
    if (disposed || opened) return;
    returnFocus = document.activeElement || trigger;
    opened = true;
    dialog.showModal();
    closeButton.focus();
    return loadInstructions();
  }
  function onKeyDown(event) {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
    } else if (event.key === 'Tab') {
      const controls = [closeButton, retry, ...contentControls].filter(control => !control.disabled && !control.hidden);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (!event.shiftKey && index === controls.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
  }
  function onCancel(event) { event.preventDefault(); closeDialog(); }
  function onNativeClose() { if (!dialog.open) finishClose(); }
  trigger.addEventListener('click', openDialog);
  closeButton.addEventListener('click', closeDialog);
  retry.addEventListener('click', loadInstructions);
  dialog.addEventListener('keydown', onKeyDown);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onNativeClose);
  return {
    open: openDialog,
    close: closeDialog,
    dispose() {
      disposed = true;
      closeDialog();
      epoch++;
      trigger.removeEventListener('click', openDialog);
      closeButton.removeEventListener('click', closeDialog);
      retry.removeEventListener('click', loadInstructions);
      dialog.removeEventListener('keydown', onKeyDown);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onNativeClose);
    },
  };
}

const LOG_STAGES = Object.freeze({
  capture: 'Capture', candidates: 'Candidate discovery', classification: 'Classification',
  apply: 'Graph update', skip: 'Skipped',
});
const LOG_ACTIVITIES = ['inspect', 'propose', 'implement', 'verify', 'repair', 'explain', 'other'];
const LOG_REASONS = Object.freeze({
  no_candidates: 'No candidates found', no_approved_candidates: 'No candidates passed intake',
  no_accepted_classification: 'No classification met acceptance requirements',
  insufficient_relevance: 'Relevance was below the required score',
  metadata_only: 'Source interpretation is off', classification_paused: 'Classification is paused',
  below_drawing_floor: 'Support was too low to draw', stale_result: 'Evidence changed before the result arrived',
  no_graph_changes: 'No graph changes', unchanged: 'Evidence is unchanged',
  deadline_exceeded: 'Classification deadline elapsed', cache_hit: 'A cached result was used',
  no_graph_change: 'No graph changes', patch_applied: 'Graph changes applied',
  paused_deferred: 'Classification is paused; work is waiting',
  source_changed_during_classification: 'The source changed before classification finished',
  classification_not_drawable: 'The classification produced no drawable result',
  candidates_ready: 'Candidates are ready for classification', classification_started: 'Classification started',
  snippet_limit: 'Source window limit reached',
});
const LOG_LIMITS = Object.freeze({ records: 300, rows: 100, artifacts: 24, candidates: 48, edges: 72, requests: 12 });
const fixedCode = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value) ? value : '';
const logNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
const logProbability = value => probability(value) ? value : null;
const logBoolean = value => typeof value === 'boolean' ? value : null;
const logLabel = value => safeText(value, 120).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
const logReason = value => LOG_REASONS[value] || upperFirst(logLabel(value)) || 'No reason reported';

function diagnosticNextAction(entry) {
  const reason = entry.reason || entry.diagnostics.code;
  if (reason === 'metadata_only') return 'To interpret source, review source consent in the Graphlin server setup.';
  if (['paused_deferred', 'classification_paused'].includes(reason)) return 'Resume classification in the viewer to process waiting evidence.';
  if (['missing_key', 'missing_api_key', 'classifier_unavailable'].includes(reason)) return 'Check the TypeSafe key and classifier configuration in the Graphlin server terminal.';
  if (['deadline_exceeded', 'classifier_exception'].includes(reason)) return 'Check the server’s classifier connection, then let your agent read the file again.';
  if (['stale_result', 'source_changed_during_classification', 'queued_source_superseded'].includes(reason)) return 'Let your agent read the latest file version; this result cannot support the current source.';
  if (['no_candidates', 'no_approved_candidates', 'no_accepted_classification', 'insufficient_relevance', 'classification_not_drawable'].includes(reason)) return 'Ask your agent to read the main implementation files and their dependencies. A captured event may produce no shape.';
  if (reason === 'classification_queue_full' || reason === 'capture_queue_full') return 'Let queued work finish, then ask your agent to read the file again.';
  return '';
}

function logNumbers(value) {
  if (!record(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 32)
    .filter(([key, value]) => fixedCode(key) && logNumber(value) !== null));
}

export function normalizeDiagnostics(value) {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('invalid_diagnostics');
  const selected = value.records.slice(-LOG_LIMITS.records);
  const records = selected.filter(record).map((entry, index) => {
    const diagnostics = record(entry.diagnostics) ? entry.diagnostics : {};
    const trace = record(diagnostics.trace) ? diagnostics.trace : {};
    const patch = record(entry.patch) ? entry.patch : {};
    const reasons = values => array(values).slice(0, 12).map(fixedCode).filter(Boolean);
    const candidates = array(entry.candidates).slice(0, LOG_LIMITS.candidates).filter(record).map(candidate => ({
      candidateId: identifier(candidate.candidateId), artifactId: identifier(candidate.artifactId),
      label: safeText(candidate.label, 240), sourceClass: fixedCode(candidate.sourceClass),
      startLine: logNumber(candidate.startLine), endLine: logNumber(candidate.endLine), complete: logBoolean(candidate.complete),
    }));
    const sequence = logNumber(entry.sequence ?? entry.seq);
    const at = validTime(entry.at);
    const id = identifier(entry.id);
    return {
      id, sequence, at: at === null ? null : new Date(at).toISOString(),
      stage: token(entry.stage, Object.keys(LOG_STAGES), 'unknown'),
      eventId: identifier(entry.eventId), sourceEventId: identifier(entry.sourceEventId),
      sessionId: identifier(entry.sessionId), eventKind: fixedCode(entry.eventKind),
      toolCategory: fixedCode(entry.toolCategory), status: fixedCode(entry.status), reason: fixedCode(entry.reason),
      artifacts: array(entry.artifacts).slice(0, LOG_LIMITS.artifacts).filter(record).map(artifact => ({
        artifactId: identifier(artifact.artifactId), path: safeText(artifact.path, 1024),
        status: fixedCode(artifact.status), complete: logBoolean(artifact.complete), candidateCount: logNumber(artifact.candidateCount),
        availableCandidates: logNumber(artifact.availableCandidates), reason: fixedCode(artifact.reason),
      })),
      candidates,
      diagnostics: {
        code: fixedCode(diagnostics.code), durationMs: logNumber(diagnostics.durationMs), calls: logNumber(diagnostics.calls),
        candidatesOmitted: logNumber(diagnostics.candidatesOmitted), proposalsOmitted: logNumber(diagnostics.proposalsOmitted),
        questionCounts: logNumbers(diagnostics.questionCounts), stageDurationMs: logNumbers(diagnostics.stageDurationMs),
        extraction: array(diagnostics.extraction).slice(0, 33).filter(record).map(item => ({
          artifactId: identifier(item.artifactId), available: logNumber(item.available), selected: logNumber(item.selected), reason: fixedCode(item.reason),
          truncated: item.truncated === true,
        })),
        admission: array(diagnostics.admission).slice(0, 32).filter(record).map(item => ({
          candidateId: identifier(item.candidateId), proposalId: identifier(item.proposalId), status: fixedCode(item.status), reason: fixedCode(item.reason),
        })),
        trace: {
          activity: record(trace.activity) && LOG_ACTIVITIES.includes(trace.activity.choice) ? {
            choice: trace.activity.choice,
            confidence: logProbability(trace.activity.confidence),
            probabilities: Object.fromEntries(LOG_ACTIVITIES.filter(activity => probability(trace.activity.probabilities?.[activity]))
              .map(activity => [activity, trace.activity.probabilities[activity]])),
          } : null,
          thresholds: {
            ...logNumbers(trace.thresholds),
            ...Object.fromEntries(['intake', 'admission', 'intakePolicy', 'admissionPolicy']
              .filter(key => record(trace.thresholds?.[key])).map(key => [key, logNumbers(trace.thresholds[key])])),
          },
          relevance: logProbability(trace.relevance),
          intake: array(trace.intake).slice(0, LOG_LIMITS.candidates).filter(record).map(item => ({
            candidateId: identifier(item.candidateId), relevant: logProbability(item.relevant),
            sensitive: logProbability(item.sensitive), approved: logBoolean(item.approved), reason: fixedCode(item.reason),
            materialized: logBoolean(item.materialized),
          })),
          nodes: array(trace.nodes).slice(0, LOG_LIMITS.candidates).filter(record).map(item => ({
            candidateId: identifier(item.candidateId), role: token(item.role, [...ROLES, 'unknown'], 'unknown'),
            supportProbability: logProbability(item.supportProbability), roleProbability: logProbability(item.roleProbability),
            roleConfidence: logProbability(item.roleConfidence), classification: fixedCode(item.classification), reasons: reasons(item.reasons),
            roleProbabilities: Object.fromEntries([...ROLES, 'unknown'].filter(role => probability(item.roleProbabilities?.[role]))
              .map(role => [role, item.roleProbabilities[role]])),
          })),
          edges: array(trace.edges).slice(0, LOG_LIMITS.edges).filter(record).map(item => ({
            proposalId: identifier(item.proposalId), sourceCandidateId: identifier(item.sourceCandidateId),
            targetCandidateId: identifier(item.targetCandidateId), relation: token(item.relation, RELATIONS, 'unknown'),
            evidenceCandidateIds: array(item.evidenceCandidateIds).slice(0, 16).map(identifier).filter(Boolean),
            supportProbability: logProbability(item.supportProbability), missingContextProbability: logProbability(item.missingContextProbability),
            classification: fixedCode(item.classification), reasons: reasons(item.reasons),
          })),
          requests: array(trace.requests).slice(0, LOG_LIMITS.requests).filter(record).map(item => ({
            stage: fixedCode(item.stage), model: safeText(item.model, 120), rubricVersion: safeText(item.rubricVersion, 120),
            status: fixedCode(item.status), code: fixedCode(item.code), durationMs: logNumber(item.durationMs),
            questionCount: logNumber(item.questionCount), requestBytes: logNumber(item.requestBytes),
            dispatched: logBoolean(item.dispatched),
            httpStatus: Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 ? item.httpStatus : null,
          })),
        },
      },
      patch: Object.fromEntries(['revisionBefore', 'revisionAfter', 'nodesAdded', 'nodesUpdated', 'nodesRemoved',
        'edgesAdded', 'edgesUpdated', 'edgesRemoved'].map(key => [key, logNumber(patch[key])])),
      // Keys are presentation-only; neither raw records nor canonical graph data are edited.
      key: JSON.stringify([id, sequence, at, identifier(entry.eventId), fixedCode(entry.stage), id || sequence !== null ? null : index]),
      truncated: entry.truncated === true,
      trimmed: entry.truncated === true || [
        [entry.artifacts, LOG_LIMITS.artifacts], [entry.candidates, LOG_LIMITS.candidates],
        [trace.intake, LOG_LIMITS.candidates], [trace.nodes, LOG_LIMITS.candidates],
        [trace.edges, LOG_LIMITS.edges], [trace.requests, LOG_LIMITS.requests],
        [diagnostics.extraction, 33], [diagnostics.admission, 32],
      ].some(([items, limit]) => Array.isArray(items) && items.length > limit),
    };
  });
  return {
    schemaVersion: 1, records, stats: logNumbers(value.stats), logPath: safeText(value.logPath, 1024),
    omitted: Math.max(0, value.records.length - records.length),
  };
}

export function filterDiagnostics(records, { query = '', sessionId = '' } = {}) {
  const terms = safeText(query, 200).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return records.filter(entry => {
    if (sessionId && entry.sessionId !== sessionId) return false;
    const searchable = [entry.eventId, entry.sourceEventId, entry.sessionId, entry.eventKind, entry.toolCategory,
      entry.stage, entry.status, entry.reason, logReason(entry.reason), entry.diagnostics.code, entry.diagnostics.trace.activity?.choice,
      ...entry.artifacts.flatMap(artifact => [artifact.artifactId, artifact.path]),
      ...entry.candidates.flatMap(candidate => [candidate.candidateId, candidate.artifactId, candidate.label]),
    ].join(' ').toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  }).reverse();
}

export function startDiagnosticsDialog({ load = options => request('/api/diagnostics', options), currentSession = () => '' } = {}) {
  const $ = id => document.getElementById(id);
  const dialog = $('diagnostics-dialog'), trigger = $('classification-log'), closeButton = $('diagnostics-close');
  const search = $('diagnostics-search'), scope = $('diagnostics-session'), refresh = $('diagnostics-refresh');
  let opened = false, disposed = false, epoch = 0, returnFocus = null, selectedSession = '';
  let info = null, rows = [], loadController = null;

  function abortLoad() {
    const pending = loadController;
    loadController = null;
    pending?.abort();
  }

  function percent(value) { return value === null ? 'Not reported' : `${Math.round(value * 1000) / 10}%`; }
  function fact(list, label, value) {
    if (value === '' || value === null || value === undefined) return;
    const item = html('div');
    item.append(html('dt', label), html('dd', String(value)));
    list.append(item);
  }
  function table(title, headings, values) {
    const section = html('section', undefined, 'diagnostics-detail-section');
    section.append(html('h3', title));
    const wrap = html('div', undefined, 'diagnostics-table-wrap');
    wrap.setAttribute('tabindex', '0'); wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${title}, scrollable table`);
    const table = html('table'), head = html('thead'), header = html('tr'), body = html('tbody');
    table.setAttribute('aria-label', title);
    headings.forEach(label => { const cell = html('th', label); cell.setAttribute('scope', 'col'); header.append(cell); });
    head.append(header);
    values.slice(0, 20).forEach(values => { const row = html('tr'); values.forEach(value => row.append(html('td', String(value)))); body.append(row); });
    table.append(head, body); wrap.append(table); section.append(wrap);
    section.scrollControl = wrap;
    if (values.length > 20) section.append(html('p', 'First 20 shown. More entries appear in the diagnostic JSON below.', 'diagnostics-note'));
    return section;
  }
  function detail(entry) {
    const body = html('div', undefined, 'diagnostics-detail');
    const facts = html('dl', undefined, 'diagnostics-facts');
    const trace = entry.diagnostics.trace;
    fact(facts, 'Reason code', entry.reason || entry.diagnostics.code || 'Not reported');
    fact(facts, 'Recorded at', entry.at);
    fact(facts, 'Event', entry.eventId); fact(facts, 'Source event', entry.sourceEventId);
    fact(facts, 'Session', entry.sessionId || 'Not assigned');
    fact(facts, 'Captured event', [entry.eventKind, entry.toolCategory].filter(Boolean).join(' / '));
    fact(facts, 'Activity classification', trace.activity ? upperFirst(trace.activity.choice) : 'Not recorded at this stage');
    if (trace.activity) fact(facts, 'Activity confidence', percent(trace.activity.confidence));
    fact(facts, 'Duration', entry.diagnostics.durationMs === null ? null : `${entry.diagnostics.durationMs} ms`);
    fact(facts, 'Classifier calls', entry.diagnostics.calls);
    fact(facts, 'Candidates omitted', entry.diagnostics.candidatesOmitted);
    fact(facts, 'Relation proposals omitted', entry.diagnostics.proposalsOmitted);
    if (entry.patch.revisionBefore !== null || entry.patch.revisionAfter !== null) {
      fact(facts, 'Graph revision', `${entry.patch.revisionBefore ?? 'Unknown'} → ${entry.patch.revisionAfter ?? 'Unknown'}`);
      fact(facts, 'Components', ['Added', 'Updated', 'Removed'].map(action => `${action.toLowerCase()}: ${entry.patch[`nodes${action}`] ?? 'not reported'}`).join(', '));
      fact(facts, 'Relationships', ['Added', 'Updated', 'Removed'].map(action => `${action.toLowerCase()}: ${entry.patch[`edges${action}`] ?? 'not reported'}`).join(', '));
    }
    body.append(facts);
    if (entry.artifacts.length) body.append(table('Files considered', ['File or artifact', 'Status', 'Complete capture', 'Candidates'],
      entry.artifacts.map(item => [item.path || item.artifactId, logLabel(item.status) || 'Not reported',
        item.complete === null ? 'Not reported' : item.complete ? 'Yes' : 'No', item.candidateCount ?? 'Not reported'])));
    const labels = new Map(entry.candidates.map(item => [item.candidateId, item.label || item.candidateId]));
    const label = id => labels.get(id) || id || 'Not reported';
    const files = new Map(entry.artifacts.map(item => [item.artifactId, item.path || item.artifactId]));
    if (entry.diagnostics.extraction.length) body.append(table('Candidate discovery', ['File or artifact', 'Available', 'Selected', 'Reason'],
      entry.diagnostics.extraction.map(item => [files.get(item.artifactId) || item.artifactId || 'Not reported',
        item.available === null ? 'Not reported' : `${item.available}${item.truncated ? '+' : ''}`,
        item.selected ?? 'Not reported', logReason(item.reason)])));
    if (entry.diagnostics.admission.length) body.append(table('Drawing decisions', ['Candidate or proposal', 'Outcome', 'Reason'],
      entry.diagnostics.admission.map(item => [item.candidateId ? label(item.candidateId) : item.proposalId || 'Not reported',
        logLabel(item.status) || 'Not reported', logReason(item.reason)])));
    if (trace.requests.length) body.append(table('Classifier requests', ['Stage / model / rubric', 'Duration', 'Outcome / code', 'Questions'],
      trace.requests.slice(0, 2).map(item => [
        [item.stage || 'Stage not reported', item.model || 'Model not reported', item.rubricVersion || 'Rubric not reported'].join(' / '),
        item.durationMs === null ? 'Not reported' : `${item.durationMs} ms`,
        `${upperFirst(logLabel(item.status)) || 'Not reported'} / ${item.code || 'No code reported'}`,
        item.questionCount ?? 'Not reported',
      ])));
    const thresholdNames = {
      relevantMin: 'Minimum relevance', sensitiveMax: 'Maximum sensitivity', relevanceMin: 'Minimum relevance',
      nodeSupportMin: 'Minimum component support', roleProbabilityMin: 'Minimum role probability',
      roleConfidenceMin: 'Minimum role confidence', edgeSupportMin: 'Minimum relationship support',
      missingContextMax: 'Maximum missing context',
    };
    const thresholds = ['intake', 'admission'].flatMap(stage =>
      Object.entries(trace.thresholds[stage] || trace.thresholds[`${stage}Policy`] || {})
        .filter(([, value]) => probability(value))
        .map(([name, value]) => [upperFirst(stage), thresholdNames[name] || upperFirst(logLabel(name)), percent(value)]));
    if (thresholds.length) body.append(table('Decision thresholds', ['Stage', 'Threshold', 'Value'], thresholds.slice(0, 9)));
    if (trace.intake.length) body.append(table('Intake checks', ['Candidate', 'Relevant', 'Sensitive', 'Passes intake', 'Sent to architecture', 'Reason'],
      trace.intake.map(item => [label(item.candidateId), percent(item.relevant), percent(item.sensitive),
        item.approved === null ? 'Not reported' : item.approved ? 'Yes' : 'No',
        item.materialized === null ? 'Not reported' : item.materialized ? 'Yes' : 'No', logReason(item.reason)])));
    if (trace.relevance !== null) body.append(html('p', `Overall relevance: ${percent(trace.relevance)}`, 'diagnostics-note'));
    if (trace.nodes.length) body.append(table('Component scores', ['Candidate / role', 'Support', 'Role probability', 'Role confidence', 'Outcome / reason'],
      trace.nodes.map(item => [`${label(item.candidateId)} / ${upperFirst(item.role)}`, percent(item.supportProbability),
        percent(item.roleProbability), percent(item.roleConfidence),
        [logLabel(item.classification), ...item.reasons.map(logReason)].filter(Boolean).join('; ') || 'Not reported'])));
    if (trace.edges.length) body.append(table('Relationship scores', ['Connection', 'Support', 'Missing context', 'Outcome / reason'],
      trace.edges.map(item => [`${label(item.sourceCandidateId)} ${readable(item.relation)} ${label(item.targetCandidateId)}`,
        percent(item.supportProbability), percent(item.missingContextProbability),
        [logLabel(item.classification), ...item.reasons.map(logReason)].filter(Boolean).join('; ') || 'Not reported'])));
    if (!trace.nodes.length && !trace.edges.length && !trace.intake.length) {
      body.append(html('p', 'No component or relationship scores were recorded at this stage.', 'diagnostics-note'));
    }
    const { key, trimmed, ...safe } = entry;
    const json = JSON.stringify(safe, null, 2);
    body.append(html('h3', 'Diagnostic JSON'));
    if (entry.truncated) body.append(html('p', 'The server abbreviated this record; some diagnostic details are unavailable.', 'diagnostics-note'));
    else if (trimmed || json.length > 48000) body.append(html('p', 'Details are abbreviated to keep this viewer responsive.', 'diagnostics-note'));
    const pre = html('pre', json.slice(0, 48000) + (json.length > 48000 ? '\n… (display limit reached)' : ''));
    pre.setAttribute('tabindex', '0'); pre.setAttribute('aria-label', 'Diagnostic JSON');
    body.append(pre);
    return { body, pre, controls: [...Array.from(body.children).filter(child => child.scrollControl).map(child => child.scrollControl), pre] };
  }
  function render() {
    if (!info) return;
    const expanded = new Set(rows.filter(row => row.element.open).map(row => row.key));
    const focused = rows.find(row => row.summary === document.activeElement)?.key;
    const matches = filterDiagnostics(info.records, { query: search.value, sessionId: scope.value === 'current' ? selectedSession : '' });
    rows = matches.slice(0, LOG_LIMITS.rows).map(entry => {
      const element = html('details', undefined, 'diagnostics-record'), summary = html('summary');
      const heading = html('span', undefined, 'diagnostics-record-heading');
      const stage = html('span', LOG_STAGES[entry.stage] || 'Other stage', 'diagnostics-stage');
      stage.dataset.stage = entry.stage;
      const time = html('time', entry.at ? formatTime(validTime(entry.at)) : 'Time not reported');
      if (entry.at) { time.setAttribute('datetime', entry.at); time.setAttribute('title', entry.at); }
      heading.append(stage, html('strong', logReason(entry.reason || entry.diagnostics.code)), time);
      const path = entry.artifacts.map(item => item.path || item.artifactId).filter(Boolean);
      const labels = entry.candidates.map(item => item.label).filter(Boolean);
      summary.append(heading, html('span', [...path.slice(0, 2), ...labels.slice(0, 2)].join(' · ') || entry.eventKind || 'No file or candidate label recorded', 'diagnostics-record-path'));
      summary.append(html('span', [upperFirst(logLabel(entry.status)) || 'Status not reported',
        entry.candidates.length ? `${entry.candidates.length} candidates` : '', entry.sessionId ? `Session ${shortId(entry.sessionId)}` : 'Session not assigned',
      ].filter(Boolean).join(' · '), 'diagnostics-record-meta'));
      const next = diagnosticNextAction(entry);
      if (next) summary.append(html('span', next, 'diagnostics-record-meta'));
      element.append(summary);
      const row = { key: entry.key, element, summary, pre: null, controls: [] };
      const expand = () => {
        if (!element.open || row.pre) return;
        const content = detail(entry);
        row.pre = content.pre;
        row.controls = content.controls;
        element.append(content.body);
      };
      element.addEventListener('toggle', expand);
      if (expanded.has(entry.key)) { element.open = true; expand(); }
      return row;
    });
    $('diagnostics-records').replaceChildren(...rows.map(row => row.element));
    $('diagnostics-count').textContent = `Showing ${rows.length} of ${matches.length} matching records, newest first.${info.omitted ? ` ${info.omitted} older or unsupported records are outside this view.` : ''}`;
    $('diagnostics-empty').hidden = rows.length > 0;
    $('diagnostics-empty').textContent = info.records.length
      ? 'No records match these filters. Try All sessions or a different file, label, or event.'
      : 'No classification records yet. After restarting the updated server, let your agent read or change a file, then refresh.';
    $('diagnostics-log-path').hidden = !info.logPath;
    $('diagnostics-log-path').textContent = info.logPath ? `Local log: ${info.logPath}` : '';
    $('diagnostics-stats').textContent = Object.entries(info.stats).slice(0, 8).map(([key, value]) => `${upperFirst(logLabel(key))}: ${value}`).join(' · ');
    if (focused) (rows.find(row => row.key === focused)?.summary || refresh).focus();
  }
  async function reload() {
    if (!opened || disposed) return;
    const ticket = ++epoch;
    abortLoad();
    const controller = new AbortController();
    loadController = controller;
    refresh.disabled = true;
    $('diagnostics-loading').hidden = false;
    $('diagnostics-error').hidden = true;
    $('diagnostics-error').textContent = '';
    $('diagnostics-records').setAttribute('aria-busy', 'true');
    try {
      const next = normalizeDiagnostics(await load({ signal: controller.signal }));
      if (!opened || disposed || ticket !== epoch) return;
      info = next;
      render();
      $('diagnostics-updated').textContent = `Refreshed ${formatTime(Date.now())}. Refresh to see newer records.`;
    } catch (cause) {
      if (!opened || disposed || ticket !== epoch) return;
      $('diagnostics-error').textContent = cause.status === 404 || cause.message === 'invalid_diagnostics'
        ? 'This server does not provide the classification log yet. Restart the updated local server, then refresh. Earlier scores cannot be recovered.'
        : cause.message === 'auth_required'
          ? 'Viewer authorization is required. Reopen a fresh viewer link from the local server.'
          : `The classification log could not be loaded. Check the local server and refresh. If it was started before this update, restart it.${info ? ' Showing the last loaded records.' : ''}`;
      $('diagnostics-error').hidden = false;
    } finally {
      if (loadController === controller) loadController = null;
      if (opened && ticket === epoch) {
        refresh.disabled = false;
        $('diagnostics-loading').hidden = true;
        $('diagnostics-records').setAttribute('aria-busy', 'false');
      }
    }
  }
  function finishClose() {
    if (!opened) return;
    opened = false; epoch++;
    abortLoad();
    info = null; rows = [];
    $('diagnostics-records').replaceChildren();
    for (const id of ['diagnostics-log-path', 'diagnostics-stats', 'diagnostics-count', 'diagnostics-updated', 'diagnostics-error']) $(id).textContent = '';
    $('diagnostics-log-path').hidden = true; $('diagnostics-loading').hidden = true; $('diagnostics-error').hidden = true;
    $('diagnostics-records').setAttribute('aria-busy', 'false');
    refresh.disabled = false;
    const destination = returnFocus && document.body.contains(returnFocus) && !returnFocus.disabled ? returnFocus : trigger;
    returnFocus = null;
    if (!disposed) destination.focus({ preventScroll: true });
  }
  function closeDialog() { if (opened) { dialog.close(); finishClose(); } }
  function openDialog() {
    if (disposed || opened) return;
    selectedSession = identifier(currentSession());
    search.value = ''; scope.value = selectedSession ? 'current' : 'all';
    const current = html('option', selectedSession ? `Current session (${shortId(selectedSession)})` : 'Current session unavailable');
    current.value = 'current'; current.disabled = !selectedSession;
    const all = html('option', 'All sessions'); all.value = 'all';
    scope.replaceChildren(current, all);
    scope.value = selectedSession ? 'current' : 'all';
    returnFocus = document.activeElement || trigger;
    opened = true;
    $('diagnostics-empty').hidden = true;
    dialog.showModal(); closeButton.focus();
    return reload();
  }
  function onKeyDown(event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); }
    else if (event.key === 'Tab') {
      const controls = [closeButton, search, scope, refresh, ...rows.flatMap(row => [row.summary, ...(row.element.open ? row.controls : [])])]
        .filter(control => !control.disabled && !control.hidden);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (!event.shiftKey && index === controls.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
  }
  const onFilter = () => { if (opened) render(); };
  const onCancel = event => { event.preventDefault(); closeDialog(); };
  const onNativeClose = () => { if (!dialog.open) finishClose(); };
  trigger.addEventListener('click', openDialog); closeButton.addEventListener('click', closeDialog);
  refresh.addEventListener('click', reload); search.addEventListener('input', onFilter); scope.addEventListener('change', onFilter);
  dialog.addEventListener('keydown', onKeyDown); dialog.addEventListener('cancel', onCancel); dialog.addEventListener('close', onNativeClose);
  return {
    open: openDialog,
    close: closeDialog,
    dispose() {
      disposed = true; closeDialog(); epoch++;
      abortLoad();
      trigger.removeEventListener('click', openDialog); closeButton.removeEventListener('click', closeDialog);
      refresh.removeEventListener('click', reload); search.removeEventListener('input', onFilter); scope.removeEventListener('change', onFilter);
      dialog.removeEventListener('keydown', onKeyDown); dialog.removeEventListener('cancel', onCancel); dialog.removeEventListener('close', onNativeClose);
    },
  };
}

export function startViewer() {
  const $ = id => document.getElementById(id);
  const state = {
    snapshot: null, selection: null, replayFrame: null, frames: [], stream: null,
    connection: 'connecting', busy: false, exporting: false, epoch: 0, connectEpoch: 0,
    viewport: null, fitBounds: null, zoom: 1, followFit: true, lastGraphSignature: '', inspectorSignature: '',
    nodeElements: new Map(), edgeElements: new Map(), activityElements: new Map(),
    views: new Map(), viewKey: null, view: null, displayGraph: null, searchQuery: '',
    nodeTypes: null, nodeTypeButtons: new Map(), manualCamera: false,
    effects: new Map(), liveReady: false, motionReady: false, movement: null, closed: false, projectName: '',
    model: null, scene: null, projectedGraph: null, platformActive: false, custom: false, follow: true, viewName: 'Code',
  };
  const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const sketches = createSketchCache();
  const detailSketches = createSketchCache(sketchDetails);
  const dashboardInfo = startDashboardInfo();
  const connectionDialog = startConnectionDialog({ onInfo: info => {
    state.projectName = friendlyProjectName(info.projectRoot);
    renderStatus();
  } });
  const diagnosticsDialog = startDiagnosticsDialog({ currentSession: () => state.snapshot?.sessionId });
  const sidebar = createLiveSidebar({
    onInspect(selection, id) {
      const target = typeof selection === 'string' ? { type: selection, id } : selection;
      if (state.closed || !record(target) || !['node', 'edge'].includes(target.type)) return;
      if (state.replayFrame) {
        resetMotionBaseline();
        state.replayFrame = null;
        render();
      }
      select(target.type, identifier(target.id));
    },
    onReplay(revision) {
      if (state.closed) return;
      const index = state.frames.findIndex(frame => frame.revision === revision);
      if (index >= 0) replayAt(index);
    },
  });
  let toastTimer;
  let announcementTimer;
  let pointer = null;
  let canvasSize = '';
  let projectController = null;
  const toolActivity = createToolActivity();
  let activityModel = null, activitySession, activityReplay = false, activityTimer, activityStripSignature = '';
  let activityFocus = [];
  const platform = createViewPlatform({
    document, request,
    onFollow(value) {
      state.follow = value;
      if (value) state.manualCamera = false;
      else { clearMotion(); state.followFit = false; }
    },
    onActivity(value, selection) {
      const replay = Boolean(selection.checkpoint);
      if (activitySession !== selection.session || activityReplay !== replay) {
        toolActivity.clear(); activityFocus = [];
      }
      activitySession = selection.session; activityReplay = replay;
      activityModel = value;
      const started = value ? toolActivity.update(value, { session: activitySession, replay }) : [];
      activityFocus.push(...started);
      refreshToolActivity();
      const follow = state.follow && !state.manualCamera && !state.searchQuery && state.nodeTypes === null && !replay;
      return { follow, revealEntityIds: follow && value ? toolActivity.current()
        .filter(call => call.active && started.includes(call.key))
        .flatMap(call => activityTargets(call, value))
        .filter(id => ['file', 'module'].includes(value.entities.find(entity => entity.id === id)?.kind)) : [] };
    },
    onSelect({ entityId, relationId, activityId }) {
      if (entityId) {
        platform.selected(entityId);
        select('node', state.scene ? representedSelection(entityId, state.scene, state.model) || entityId : entityId);
        revealInspector();
      } else if (relationId) {
        const edge = state.scene?.edges.find(edge => edge.relationIds?.includes(relationId));
        if (edge) select('edge', edge.id);
      } else if (activityId) {
        const event = state.model?.activity.find(event => event.id === activityId);
        if (event) {
          $('inspector-body').replaceChildren(html('h3', readable(event.kind || 'Activity')),
            html('p', `Outcome: ${event.outcome || 'unresolved'}. Attribution: ${event.attribution || 'unknown'}.`),
            html('p', 'This observation has no linked source entity.'));
          revealInspector();
        }
      }
    },
    onView(result) {
      if (state.closed) return;
      if (result.clear) {
        state.scene = null; state.projectedGraph = null; state.custom = false;
        state.displayGraph = null; state.selection = null; state.inspectorSignature = '';
        clearMotion();
        for (const layer of ['group-layer', 'node-layer', 'edge-layer', 'edge-label-layer']) $(layer)?.replaceChildren();
        state.nodeElements.clear(); state.edgeElements.clear();
        $('architecture').hidden = true; $('architecture').setAttribute('aria-hidden', 'true');
        $('custom-view').hidden = true; $('empty-canvas').hidden = true;
        refreshToolActivity();
        $('inspector-body').replaceChildren(html('p', 'Select an item in the active view to inspect its evidence.'));
        updateControls();
        return;
      }
      const previous = state.projectedGraph, previousModel = state.model;
      const switched = !state.platformActive || state.viewName !== result.name || previousModel?.projectId !== result.model.projectId;
      state.platformActive = true; state.model = result.model; state.scene = result.scene || null;
      state.custom = result.kind === 'custom'; state.customCount = result.itemCount; state.viewName = result.name;
      state.projectedGraph = result.scene ? sceneGraph(result.scene, result.model) : null;
      $('architecture').hidden = state.custom; $('custom-view').hidden = !state.custom;
      $('architecture').setAttribute('aria-hidden', String(state.custom));
      if (switched) resetMotionBaseline();
      const selectionId = state.scene && representedSelection(result.selection, state.scene, state.model);
      if (selectionId) state.selection = { type: 'node', id: selectionId };
      const following = state.follow && !state.manualCamera && !state.searchQuery && state.nodeTypes === null && !activityReplay;
      const live = result.streamed && !switched && following;
      const arrivals = liveNodeChanges(previous, state.projectedGraph, live);
      const requested = toolActivity.current().find(call => call.active && activityFocus.includes(call.key));
      const target = requested && state.scene && activityTargets(requested, state.model)
        .map(id => representedSelection(id, state.scene, state.model)).find(Boolean);
      const focusNodeId = following && !switched && target ? target : live && state.scene && result.focusEntityId
        ? representedSelection(result.focusEntityId, state.scene, state.model) : arrivals.added.at(-1);
      activityFocus = [];
      const before = state.displayGraph;
      render({ forceFit: result.force || switched, focusNodeId });
      if (!state.custom && state.scene && !state.scene.groups.length) animateChanges(arrivals, before, focusNodeId);
      const coverage = result.scene?.coverage;
      $('view-coverage').hidden = false;
      const counts = state.model.coverage?.counts || state.model.coverage || {};
      const progress = ['inventoried', 'inspected', 'deferred', 'unsupported', 'unavailable']
        .filter(key => Number.isSafeInteger(counts[key])).map(key => `${counts[key]} ${key}`).join(' · ');
      $('view-coverage').textContent = [coverage?.label || 'Observable activity; outcomes may be unresolved',
        coverage?.truncated ? `${coverage.shown} shown of ${coverage.total}; open a scope for more` : '',
        state.model.coverage?.client?.truncated
          ? `Partial scope: ${Object.entries(state.model.coverage.client.totals)
            .filter(([kind, total]) => total > state.model.coverage.client.retained[kind])
            .map(([kind, total]) => `${state.model.coverage.client.retained[kind]} of ${total} ${kind}`).join(', ')}. Open a source scope for more.` : '',
        progress].filter(Boolean).join(' · ');
    },
  });

  function activityIcon(operation) {
    const icon = svgElement('svg', { class: 'tool-activity-icon', width: 15, height: 15,
      viewBox: '0 0 20 20', 'aria-hidden': 'true' });
    if (operation === 'read') {
      icon.append(svgElement('ellipse', { cx: 5, cy: 10, rx: 4, ry: 6 }),
        svgElement('ellipse', { cx: 15, cy: 10, rx: 4, ry: 6 }),
        svgElement('circle', { cx: 6, cy: 10, r: 1.8, class: 'eye-pupil' }),
        svgElement('circle', { cx: 16, cy: 10, r: 1.8, class: 'eye-pupil' }));
    } else {
      icon.append(svgElement('path', { d: 'M3 14 13 4 17 8 7 18 2 19Z M11 6 15 10 M3 14 7 18 M14 3 16 1 20 5 18 7' }));
    }
    return icon;
  }
  function refreshToolActivity() {
    clearTimeout(activityTimer);
    const visible = !state.closed && activityModel && !activityReplay && state.platformActive &&
      activityModel.projectId === state.model?.projectId && Boolean(state.scene || state.custom);
    const calls = visible ? toolActivity.current() : [];
    const badges = visible && state.scene ? sceneActivity(state.scene, state.model, calls) : new Map();
    for (const [id, group] of state.nodeElements) {
      const values = badges.get(id) || [], node = state.displayGraph?.nodes.find(value => value.id === id);
      const signature = JSON.stringify(values.map(value => [value.operation, value.outcome, value.count, value.opacity]));
      // Group headers may have been rebuilt by a normal graph render.
      if (group.activitySignature === signature && (!values.length || group.activityOverlay?.parentElement === group)) continue;
      group.activityOverlay?.remove(); group.activityOverlay = null; group.activitySignature = signature;
      group.dataset.reading = String(values.some(value => value.operation === 'read' && value.active));
      group.dataset.editing = String(values.some(value => value.operation === 'edit' && value.active));
      if (group.activityAria) group.setAttribute('aria-label', group.activityAria);
      if (!values.length || !node) {
        if (group.isSceneGroup) group.querySelector('[class="group-summary"]')?.setAttribute('visibility', 'visible');
        continue;
      }
      group.setAttribute('aria-label', `${group.activityAria || group.getAttribute('aria-label')} Tool activity: ${
        values.map(value => `${value.label}${value.count > 1 ? ` (${value.count} calls)` : ''}`).join('; ')}.`);
      if (group.isSceneGroup) group.querySelector('[class="group-summary"]')?.setAttribute('visibility', 'hidden');
      const row = svgElement('g', { class: 'tool-activity-badges', 'aria-hidden': 'true', 'pointer-events': 'none' });
      const operations = ['read', 'edit'].filter(operation => values.some(value => value.operation === operation));
      let x = 10;
      for (const operation of operations) {
        const same = values.filter(value => value.operation === operation), value = same[0];
        const otherFailure = value.active && same.some(item => !item.active && item.outcome !== 'succeeded');
        const text = `${value.label}${value.count > 1 ? ` ×${value.count}` : ''}${otherFailure ? ' !' : ''}`;
        const width = Math.min(((node.width || NODE_WIDTH) - 24) / operations.length, Math.max(70, text.length * 5.3 + 26));
        const badge = svgElement('g', { class: 'tool-activity-badge', 'data-operation': operation,
          'data-outcome': value.outcome, opacity: value.opacity, transform: `translate(${x} ${node.isGroup ? 34 : 7})` });
        const icon = activityIcon(operation);
        icon.setAttribute('x', 5); icon.setAttribute('y', 3);
        badge.append(svgElement('rect', { width, height: 22, rx: 5 }), icon,
          svgElement('text', { x: 23, y: 15, ...(text.length * 5.3 > width - 27
            ? { textLength: width - 27, lengthAdjust: 'spacingAndGlyphs' } : {}) }, text));
        row.append(badge); x += width + 4;
      }
      group.activityOverlay = row; group.append(row);
    }
    const items = calls.slice(0, 4).map(call => {
      const targets = activityTargets(call, activityModel);
      const entity = activityModel.entities.find(value => value.id === targets[0]);
      const represented = entity && state.scene && representedSelection(entity.id, state.scene, state.model);
      const block = state.scene?.groups.find(group => group.id === represented);
      const label = entity?.label || 'File target not in this scope';
      return { call, text: `${call.label} ${label}${block && block.label !== label ? ` · in ${block.label}` : ''}` };
    });
    const signature = JSON.stringify([items.map(({ call, text }) => [call.key, call.outcome, text]), calls.length]);
    $('current-activity').hidden = !calls.length;
    if (signature !== activityStripSignature) {
      activityStripSignature = signature;
      $('current-activity-items').replaceChildren(...items.map(({ call, text }) => {
        const item = html('span', undefined, 'current-activity-item');
        item.dataset.operation = call.operation; item.dataset.outcome = call.outcome;
        item.setAttribute('title', `${text}. ${call.mapping === 'decision' ? 'Decision-mapped target.' : 'Exact file target.'} Tool status does not verify source changes.`);
        item.append(activityIcon(call.operation), html('span', text));
        return item;
      }));
      if (calls.length > items.length) $('current-activity-items').append(html('span', `+${calls.length - items.length} more calls`, 'current-activity-more'));
    }
    items.forEach(({ call }, index) => {
      const item = $('current-activity-items').children[index];
      if (item) item.dataset.fade = String(Math.ceil(call.opacity * 4));
    });
    if (calls.length) activityTimer = setTimeout(refreshToolActivity, 250);
  }

  function announce(message) {
    clearTimeout(announcementTimer);
    announcementTimer = setTimeout(() => { $('announcement').textContent = message; }, 250);
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }
  function error(message = '') {
    $('error-banner').textContent = message;
    $('error-banner').hidden = !message;
  }
  function connection(value) {
    state.connection = value;
    $('connection').dataset.state = value;
    $('connection-label').textContent = {
      connecting: 'Connecting to local service',
      connected: 'Connected to local service',
      reconnecting: 'Disconnected · reconnecting',
      error: 'Local service unavailable',
      auth: 'Viewer authorization required',
    }[value] || 'Connection unknown';
    $('retry').hidden = value === 'connected' || value === 'connecting';
    renderOnboarding();
    updateControls();
  }
  function renderOnboarding() {
    const progress = onboardingProgress(state.snapshot, state.connection);
    for (const step of progress.steps) {
      const element = $(`onboarding-${step.id}`);
      element.textContent = step.label;
      element.dataset.state = step.state;
    }
    $('onboarding-next').textContent = progress.next.text;
    $('onboarding-action').textContent = progress.next.label;
    $('onboarding-action').dataset.action = progress.next.action;
    // Preserve a manual text selection while live snapshots arrive.
    if ($('orientation-prompt').textContent !== ORIENTATION_PROMPT) $('orientation-prompt').textContent = ORIENTATION_PROMPT;
    $('orientation').hidden = Boolean(state.searchQuery || state.nodeTypes !== null || state.replayFrame || state.snapshot?.mode === 'demo' || state.snapshot?.mode === 'replay');
  }
  function currentGraph() { return state.platformActive ? state.projectedGraph || { revision: state.model?.revision || 0, nodes: [], edges: [] }
    : state.replayFrame?.graph || state.snapshot?.graph; }
  function applyTheme() {
    const theme = token(state.view?.theme, THEMES, 'sketchbook');
    if ($('drawing').dataset.theme !== theme) $('drawing').dataset.theme = theme;
    $('theme').value = theme;
  }
  function presentation() {
    const key = presentationKey(state.snapshot, state.replayFrame) + (state.platformActive ? `:${platform.active}:${JSON.stringify(platform.selection)}` : '');
    if (state.viewKey !== key) {
      finishPan();
      clearMotion();
      state.liveReady = false;
      state.motionReady = false;
      let view = state.views.get(key);
      if (!view) view = createPresentation();
      state.views.delete(key);
      state.views.set(key, view);
      while (state.views.size > MAX_VIEWS) state.views.delete(state.views.keys().next().value);
      state.view = view;
      state.viewKey = key;
      state.viewport = view.camera ? { ...view.camera.viewport } : null;
      state.fitBounds = view.camera ? { ...view.camera.fitBounds } : null;
      state.zoom = view.camera?.zoom || 1;
      state.followFit = view.camera?.followFit ?? true;
      state.lastGraphSignature = '';
    }
    return state.view;
  }
  function motionAllowed() { return !state.closed && !document.hidden && motionPreference?.matches !== true; }
  function removalBounds() {
    return [...state.effects.values()].flatMap(effect => effect.bounds ? [effect.bounds] : []);
  }
  function finishEffect(id) {
    const effect = state.effects.get(id);
    if (!effect) return;
    clearTimeout(effect.timer);
    effect.visual?.classList.remove('is-appearing');
    effect.element?.remove();
    effect.target?.removeEventListener?.('animationend', effect.finish);
    state.effects.delete(id);
    if (effect.bounds && !removalBounds().length) {
      $('empty-canvas').hidden = Boolean(state.displayGraph?.nodes.length);
      // The final pop releases its extra canvas space. A manual camera chosen
      // during the animation remains authoritative until another graph change.
      if (!state.closed && state.followFit && state.displayGraph) {
        fitCamera(state.movement?.fitDuring || graphBounds(state.displayGraph));
      }
    }
  }
  function rememberEffect(id, effect, target, duration) {
    const finish = () => { if (state.effects.get(id) === effect) finishEffect(id); };
    Object.assign(effect, { finish, target, timer: setTimeout(finish, duration + 80) });
    state.effects.set(id, effect);
    target.addEventListener('animationend', finish);
  }
  function cancelMovement({ fit = true } = {}) {
    const movement = state.movement;
    if (!movement) return;
    state.movement = null;
    window.cancelAnimationFrame?.(movement.frame);
    clearTimeout(movement.timer);
    if (state.displayGraph) paintGeometry(state.displayGraph);
    if (fit && movement.fitAfter) fitCamera(movement.fitAfter);
  }
  function clearMotion() {
    cancelMovement();
    for (const id of state.effects.keys()) finishEffect(id);
  }
  function resetMotionBaseline() {
    finishPan();
    state.liveReady = false;
    state.motionReady = false;
    clearMotion();
  }
  function animateChanges(changes, before, focusNodeId) {
    // Re-addition always cancels a removal, even when motion is suppressed.
    for (const node of currentGraph().nodes) if (state.effects.get(node.id)?.element) finishEffect(node.id);
    if (!motionAllowed()) return;
    const removals = [];
    for (const id of changes.removed) finishEffect(id);
    for (const id of changes.removed) {
      if (state.effects.size >= MAX_EFFECTS) break;
      const node = before?.nodes.find(item => item.id === id);
      if (!node) continue;
      const decoration = svgElement('g', { class: 'node-burst', 'aria-hidden': 'true', 'pointer-events': 'none', transform: `translate(${node.x + NODE_WIDTH / 2} ${node.y + NODE_HEIGHT / 2})` });
      decoration.dataset.kind = node.kind;
      const outline = svgElement('g', { class: 'burst-outline' });
      const content = svgElement('g', { transform: `translate(${-NODE_WIDTH / 2} ${-NODE_HEIGHT / 2})` });
      content.append(...shape(node), sketch(node));
      outline.append(content);
      decoration.append(outline);
      for (let index = 0; index < 8; index++) {
        const direction = svgElement('g', { transform: `rotate(${index * 45 + hashId(id) % 20})` });
        direction.append(svgElement('circle', { class: 'burst-particle', cx: 0, cy: 0, r: 3 }));
        decoration.append(direction);
      }
      // Covers the largest outline expansion and the 105px particle travel in
      // the existing pop animation, including the wider diamond silhouette.
      const bounds = { x: node.x - 64, y: node.y - 64, width: NODE_WIDTH + 128, height: NODE_HEIGHT + 128 };
      rememberEffect(id, { element: decoration, bounds }, decoration, 300);
      removals.push(decoration);
    }
    if (removals.length) {
      if (!focusNodeId) fitCamera(state.movement?.fitDuring || graphBounds(state.displayGraph));
      $('empty-canvas').hidden = true;
      $('effects-layer').append(...removals);
    }
    for (const id of changes.added) {
      finishEffect(id);
      if (state.effects.size >= MAX_EFFECTS) break;
      const visual = state.nodeElements.get(id)?.visual;
      if (!visual) continue;
      visual.classList.add('is-appearing');
      rememberEffect(id, { visual }, visual, 400);
    }
  }
  function updateControls() {
    const online = state.connection === 'connected' && Boolean(state.snapshot);
    $('onboarding-action').disabled = state.connection === 'connecting' || state.busy;
    $('session').disabled = !online || state.busy || !state.snapshot?.sessions.length;
    $('pause').disabled = !online || state.busy;
    $('export').disabled = !online || state.exporting;
    $('pause').textContent = state.busy ? 'Applying…' : state.snapshot?.paused ? 'Resume classification' : 'Pause classification';
    $('pause').setAttribute('aria-pressed', String(Boolean(state.snapshot?.paused)));
    $('replay').disabled = !state.snapshot || state.frames.length < 2;
    $('history').disabled = !state.snapshot || state.frames.length < 2;
    const nodes = currentGraph()?.nodes.length || 0;
    $('fit').disabled = !nodes;
    $('zoom-in').disabled = !nodes || state.zoom >= MAX_ZOOM;
    $('zoom-out').disabled = !nodes || state.zoom <= MIN_ZOOM;
    $('layout').disabled = !state.snapshot;
    $('theme').disabled = !state.snapshot;
    $('arrange').disabled = !nodes;
    $('auto-arrange').disabled = !state.snapshot;
    if (state.custom) for (const id of ['fit', 'zoom-in', 'zoom-out', 'arrange', 'layout', 'auto-arrange']) $(id).disabled = true;
    if (state.platformActive) { $('replay').disabled = true; $('history').disabled = true; }
  }
  function resetView() {
    resetMotionBaseline();
    state.selection = null;
    state.replayFrame = null;
    state.viewport = null;
    state.fitBounds = null;
    state.followFit = true;
    state.zoom = 1;
    state.lastGraphSignature = '';
    state.inspectorSignature = '';
  }
  function acceptSnapshot(raw, streamed = false) {
    const snapshot = normalizeSnapshot(raw);
    if (!streamed) resetMotionBaseline();
    const projectChanged = Boolean(state.snapshot && snapshot.projectId !== state.snapshot.projectId);
    const switched = state.snapshot && (snapshot.sessionId !== state.snapshot.sessionId || projectChanged);
    const eligible = !state.platformActive && state.follow && streamed && state.motionReady && !switched && !state.replayFrame &&
      snapshot.mode !== 'replay' && state.snapshot?.mode !== 'replay' && motionAllowed();
    const changes = liveNodeChanges(state.snapshot?.graph, snapshot.graph, eligible);
    // A live baseline is independent of animation preferences. Reconnects and
    // initial/session snapshots establish it without focusing an old arrival.
    const live = !state.platformActive && state.follow && streamed && state.liveReady && !switched && !state.replayFrame &&
      snapshot.mode !== 'replay' && state.snapshot?.mode !== 'replay';
    const visible = new Set(filterDiagram(snapshot.graph, state.searchQuery, state.nodeTypes).nodes.map(node => node.id));
    const focusNodeId = liveNodeChanges(state.snapshot?.graph, snapshot.graph, live).added.filter(id => visible.has(id)).at(-1);
    const before = state.displayGraph;
    cancelMovement({ fit: !focusNodeId });
    if (switched) {
      resetView();
      state.nodeTypes = null;
    }
    if (!state.snapshot || switched) platform.serverSession(snapshot.sessionId, { projectChanged });
    state.snapshot = snapshot;
    state.epoch += 1;
    state.frames = historyFrames(snapshot);
    state.replayFrame = reconcileReplayFrame(state.frames, state.replayFrame);
    render({ focusNodeId });
    animateChanges(changes, before, focusNodeId);
    state.liveReady = streamed && !state.replayFrame && snapshot.mode !== 'replay';
    state.motionReady = streamed && !state.replayFrame && snapshot.mode !== 'replay' && motionAllowed();
    $('updated-at').textContent = `Snapshot received ${formatTime(Date.now())}`;
  }
  function renderStatus() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const classifier = snapshot.paused ? 'paused' : snapshot.status.classifier;
    const labels = {
      ready: ['Classifier ready', 'Capture continues independently; readiness does not confirm a classification.'],
      metadata_only: ['Metadata only', 'Source interpretation is off; safe activity remains visible.'],
      missing_key: ['Classifier not configured', 'Configure credentials in the local service; capture continues.'],
      paused: ['Classification paused', 'Capture and evidence invalidation continue.'],
      unavailable: ['Classifier unavailable', 'Capture continues; the last accepted map is retained.'],
      timeout: ['Classification delayed', 'The decision deadline elapsed; capture continues.'],
      demo: ['Fixture classifier', 'Offline demo; no live Jev evaluation.'],
    };
    $('classifier-label').textContent = labels[classifier][0];
    $('capture-note').textContent = labels[classifier][1];
    $('classifier-dot').dataset.state = classifier === 'ready' ? 'ready' : ['unavailable', 'timeout'].includes(classifier) ? 'error' : 'waiting';
    $('coverage-label').textContent = coverageSummary(snapshot.status.coverage, snapshot.status.dropped);
    $('coverage-label').title = $('coverage-label').textContent;
    $('queue-label').textContent = `${snapshot.status.pending} pending · ${snapshot.status.calls} classifier calls`;
    $('demo-banner').hidden = snapshot.mode !== 'demo' && snapshot.status.classifier !== 'demo';
    $('project-label').textContent = state.projectName || (snapshot.projectId ? `Project ${shortId(snapshot.projectId)}` : 'Local project');
    $('project-label').title = snapshot.projectId;
    const signature = JSON.stringify(snapshot.sessions);
    if ($('session').dataset.signature !== signature) {
      const options = snapshot.sessions.map(session => {
        const option = html('option', session.label);
        option.value = session.id;
        return option;
      });
      if (!options.length) options.push(html('option', 'Waiting for a session'));
      $('session').replaceChildren(...options);
      $('session').dataset.signature = signature;
    }
    $('session').value = state.platformActive ? platform.selection.session || snapshot.sessionId || '' : snapshot.sessionId || '';
  }
  function shape(node) {
    const details = detailSketches.paths(node.shape, node.id);
    return [
      ...canonicalShape(node, details.length === 0),
      ...(details.length ? [sketchInk(details, 'node-sketch node-sketch-details')] : []),
    ];
  }
  function canonicalShape(node, includeDetails) {
    const w = NODE_WIDTH;
    const h = NODE_HEIGHT;
    const detail = d => includeDetails ? [svgElement('path', { class: 'node-detail', d })] : [];
    if (node.shape === 'cylinder') return [
      svgElement('path', { class: 'node-shape', d: `M 0 17 C 0 -2 ${w} -2 ${w} 17 L ${w} ${h - 17} C ${w} ${h + 5} 0 ${h + 5} 0 ${h - 17} Z` }),
      ...detail(`M 0 17 C 0 37 ${w} 37 ${w} 17`),
    ];
    if (node.shape === 'cloud') return [svgElement('path', { class: 'node-shape', d: `M 18 99 C -8 99 -9 53 13 45 C -2 16 34 1 58 13 C 76 -7 132 -5 145 16 C 182 7 202 36 183 57 C 207 73 191 103 169 99 Z` })];
    if (node.shape === 'diamond') return [svgElement('path', { class: 'node-shape', d: `M ${w / 2} -12 L ${w + 14} ${h / 2} L ${w / 2} ${h + 12} L -14 ${h / 2} Z` })];
    const path = d => svgElement('path', { class: 'node-shape', d });
    const box = () => svgElement('rect', { class: 'node-shape', width: w, height: h, rx: 3 });
    if (node.shape === 'browser') return [box(), ...detail(`M 0 23 H ${w}`),
      ...[12, 22, 32].map(cx => svgElement('circle', { class: 'node-detail', cx, cy: 12, r: 2 }))];
    if (node.shape === 'component') return [
      path(`M 10 0 H ${w} V ${h} H 10 Z`),
      svgElement('rect', { class: 'node-shape', x: 0, y: 18, width: 21, height: 17, rx: 1 }),
      svgElement('rect', { class: 'node-shape', x: 0, y: 68, width: 21, height: 17, rx: 1 }),
    ];
    if (node.shape === 'queue') return [box(), ...detail(`M 17 0 V ${h} M ${w - 17} 0 V ${h}`),
      ...detail('M 40 16 H 150 M 140 11 L 150 16 L 140 21')];
    if (node.shape === 'hexagon') return [path(`M 23 0 H ${w - 23} L ${w} ${h / 2} L ${w - 23} ${h} H 23 L 0 ${h / 2} Z`)];
    if (node.shape === 'class_box') return [box(), ...detail(`M 0 25 H ${w} M 0 72 H ${w}`),
      svgElement('text', { class: 'shape-symbol', x: w / 2, y: 17, 'text-anchor': 'middle' }, 'C')];
    if (node.shape === 'interface_box') return [box(), ...detail(`M 0 25 H ${w}`),
      svgElement('text', { class: 'shape-symbol', x: w / 2, y: 17, 'text-anchor': 'middle' }, '«interface»')];
    if (node.shape === 'document') return [path(`M 0 0 H ${w - 23} L ${w} 23 V ${h} H 0 Z`),
      ...detail(`M ${w - 23} 0 V 23 H ${w}`)];
    if (node.shape === 'parallelogram') return [path(`M 22 0 H ${w} L ${w - 22} ${h} H 0 Z`)];
    if (node.shape === 'folder') return [path(`M 0 10 H 66 L 78 0 H ${w} V ${h} H 0 Z`), ...detail(`M 0 24 H ${w}`)];
    return [svgElement('rect', { class: 'node-shape', width: w, height: h, rx: node.shape === 'rounded_rect' ? 10 : node.shape === 'group' ? 2 : 5 })];
  }
  function inkPath(className, d = '') {
    return svgElement('path', { class: className, d, fill: 'none', 'aria-hidden': 'true', 'pointer-events': 'none' });
  }
  function sketchInk(paths, className) {
    const group = svgElement('g', { class: className, fill: 'none', 'aria-hidden': 'true', 'pointer-events': 'none' });
    paths.forEach((d, index) => {
      group.append(inkPath(index ? 'sketch-secondary' : 'sketch-primary', d));
    });
    return group;
  }
  function sketch(node) {
    // The helper owns only seeded decoration. Canonical fills, ports and hit
    // geometry stay in the existing shape renderer. Separate bounded caches
    // reuse outlines and details in live nodes, replay and removal decorations.
    return sketchInk(sketches.paths(node.shape, node.id), 'node-sketch');
  }
  function renderShapeKey() {
    const items = [];
    for (const [kind, name] of Object.entries(ROLE_SHAPES)) {
      const item = html('span', undefined, 'shape-key-item');
      item.dataset.kind = kind;
      const preview = svgElement('svg', { viewBox: '-16 -16 222 136', 'aria-hidden': 'true', focusable: 'false' });
      const node = { shape: name, id: `shape-key-${kind}` };
      preview.append(...shape(node), sketch(node));
      item.append(preview, html('span', upperFirst(kind)));
      items.push(item);
    }
    $('shape-key-items').replaceChildren(...items);
  }
  function interactiveGroup(type, id) {
    const group = svgElement('g', { class: type === 'node' ? 'diagram-node' : 'edge-control', role: 'button', tabindex: 0 });
    group.addEventListener('click', () => select(type, id));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(type, id); }
    });
    return group;
  }
  function select(type, id) {
    state.selection = { type, id };
    if (type === 'node' && state.platformActive) {
      const node = currentGraph()?.nodes.find(node => node.id === id);
      if (node?.entityId) platform.selected(node.entityId);
    }
    updateSelection();
    renderInspector();
    renderActivity();
    const item = type === 'node' ? currentGraph()?.nodes.find(node => node.id === id) : currentGraph()?.edges.find(edge => edge.id === id);
    if (item) {
      revealInspector();
      announce(`Evidence for ${item.label} shown in the inspector.`);
    }
  }
  function revealInspector() {
    revealDetailsSection($('inspector-body')?.parentElement);
  }
  function revealDetailsSection(panel) {
    setWorkspacePanel('details', true);
    const container = $('live-sidebar');
    if (!container?.scrollTo || !container.getBoundingClientRect || !panel?.getBoundingClientRect ||
      !container.contains(panel)) return;
    const region = container.getBoundingClientRect();
    const evidence = panel.getBoundingClientRect();
    if (!Number.isFinite(region.top) || !Number.isFinite(evidence.top) || !(region.height > 0)) return;
    const headingHeight = $('details-heading')?.getBoundingClientRect?.().height || 0;
    const offset = evidence.top - region.top - (container.clientTop || 0) - headingHeight;
    if (Math.abs(offset) < 1) return;
    container.scrollTo({
      top: Math.max(0, (container.scrollTop || 0) + offset),
      behavior: motionAllowed() ? 'smooth' : 'auto',
    });
  }
  function updateSelection() {
    for (const [id, group] of state.nodeElements) group.setAttribute('aria-pressed', String(state.selection?.type === 'node' && state.selection.id === id));
    for (const [id, group] of state.edgeElements) {
      const selected = state.selection?.type === 'edge' && state.selection.id === id;
      group.dataset.selected = String(selected);
      group.control.setAttribute('aria-pressed', String(selected));
    }
  }
  function setViewBox() {
    if (!state.viewport) return;
    const box = state.viewport;
    $('architecture').setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    const percent = state.zoom * 100;
    $('zoom-level').textContent = `${percent >= 10 ? Math.round(percent) : Number(percent.toPrecision(2))}%`;
    $('architecture').classList.toggle('is-pannable', Boolean(currentGraph()?.nodes.length));
    if (state.view) state.view.camera = {
      viewport: { ...state.viewport }, fitBounds: { ...state.fitBounds }, zoom: state.zoom, followFit: state.followFit,
    };
    updateControls();
  }
  function fitCamera(bounds) {
    finishPan();
    const bursts = removalBounds();
    // With no remaining components, frame the pops themselves instead of
    // adding the empty diagram's arbitrary origin to their bounds.
    if (bursts.length && !state.displayGraph?.nodes.length) bounds = bursts[0];
    for (const burst of bursts) bounds = combinedBounds(bounds, burst);
    const canvas = $('architecture');
    const size = canvas.getBoundingClientRect?.() || $('diagram-stage').getBoundingClientRect?.();
    const fitted = fitViewport(bounds, size);
    if (size?.width > 0 && size?.height > 0) canvasSize = `${size.width}:${size.height}`;
    state.fitBounds = bounds;
    state.viewport = fitted.viewport;
    state.zoom = fitted.zoom;
    state.followFit = true;
    setViewBox();
  }
  function fitGraph() {
    const graph = state.displayGraph;
    if (!graph) return;
    state.manualCamera = false;
    cancelMovement();
    fitCamera(graphBounds(graph));
  }
  function focusNode(node, bounds) {
    finishPan();
    const zoom = Math.max(.5, state.zoom);
    const scale = state.zoom / zoom;
    const width = state.viewport.width * scale;
    const height = state.viewport.height * scale;
    state.viewport = {
      x: node.x + (node.width || NODE_WIDTH) / 2 - width / 2,
      y: node.y + (node.height || NODE_HEIGHT) / 2 - height / 2,
      width, height,
    };
    state.zoom = zoom;
    state.fitBounds = bounds;
    // Removal cleanup must not replace arrival focus with a later fit-all.
    state.followFit = false;
    setViewBox();
  }
  function zoom(factor, anchor = { x: .5, y: .5 }) {
    if (!state.viewport || !state.fitBounds) return;
    state.manualCamera = true;
    cancelMovement();
    finishPan();
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * factor));
    const scale = state.zoom / next;
    const old = state.viewport;
    state.viewport = {
      x: old.x + old.width * (1 - scale) * anchor.x,
      y: old.y + old.height * (1 - scale) * anchor.y,
      width: old.width * scale, height: old.height * scale,
    };
    state.zoom = next;
    state.followFit = false;
    setViewBox();
  }
  function renderNodeTypeFilters(canonical) {
    const container = $('node-type-filters');
    if (!container) return;
    // Discover kinds from the current canonical canvas, never search results.
    const kinds = [...new Set(canonical.nodes.map(node => node.kind))].sort();
    for (const [kind, button] of state.nodeTypeButtons) {
      if (!kinds.includes(kind)) {
        button.remove();
        state.nodeTypeButtons.delete(kind);
      }
    }
    kinds.forEach((kind, index) => {
      let button = state.nodeTypeButtons.get(kind);
      if (!button) {
        button = html('button', upperFirst(kind), 'node-type-filter');
        button.setAttribute('type', 'button');
        button.dataset.kind = kind;
        state.nodeTypeButtons.set(kind, button);
      }
      button.setAttribute('aria-pressed', String(state.nodeTypes === null || state.nodeTypes.has(kind)));
      if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
    });
    $('node-types-all')?.setAttribute('aria-pressed', String(state.nodeTypes === null));
    $('node-types-none')?.setAttribute('aria-pressed', String(state.nodeTypes?.size === 0));
  }
  function renderGraph({ forceFit = false, arrange = false, focusNodeId } = {}) {
    const canonical = currentGraph();
    if (!canonical) return;
    const view = presentation();
    applyTheme();
    if (state.platformActive && !state.scene) {
      $('canvas-title').textContent = state.viewName;
      $('graph-count').textContent = state.custom && Number.isSafeInteger(state.customCount) ? `${state.customCount} items` : '';
      $('revision').textContent = `Revision ${state.model.revision}`;
      $('empty-canvas').hidden = true;
      refreshToolActivity();
      return;
    }
    renderNodeTypeFilters(state.platformActive ? { nodes: state.model.entities } : canonical);
    // Lay out only visible nodes so hidden components leave no empty slots.
    // Evidence, exports and live arrival detection retain the canonical graph.
    const graph = state.scene?.groups.length ? sceneGraph(layoutScene(state.scene), state.model)
      : projectPresentation(state.scene ? canonical : filterDiagram(canonical, state.searchQuery, state.nodeTypes), view, { arrange });
    state.displayGraph = graph;
    const routes = graphEdgeRoutes(graph);
    const bounds = graphBounds(graph, routes);
    const signature = cameraGraphSignature(graph, view.algorithm);
    // Focus the final projected position before inserting newcomers. Other
    // diagram changes retain fit-all; metadata-only updates keep the camera.
    const newest = graph.nodes.find(node => node.id === focusNodeId);
    if (newest && state.viewport && !forceFit) focusNode(newest, bounds);
    else if (forceFit || !state.viewport || (state.follow && (!state.platformActive || !state.manualCamera) && signature !== state.lastGraphSignature)) fitCamera(bounds);
    state.lastGraphSignature = signature;
    $('layout').value = view.algorithm;
    $('auto-arrange').checked = view.auto;
    $('layout-note').textContent = view.algorithm === 'original' ? 'Original positions from this revision.'
      : view.auto ? 'Arranges when components or connections change.' : 'Positions held. Arrange to move them.';
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const wantedEdges = new Set(graph.edges.map(edge => edge.id));
    for (const [id, group] of state.nodeElements) if (!nodes.has(id)) { group.remove(); state.nodeElements.delete(id); }
    for (const [id, group] of state.edgeElements) if (!wantedEdges.has(id)) {
      group.control.remove();
      group.remove();
      state.edgeElements.delete(id);
    }
    for (const edge of graph.edges) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      const route = routes.get(edge.id);
      const summary = claimSummary(edge);
      let group = state.edgeElements.get(edge.id);
      if (!group) {
        group = svgElement('g', { class: 'diagram-edge' });
        group.titleElement = svgElement('title');
        group.hit = svgElement('path', { class: 'edge-hit', 'pointer-events': 'stroke' });
        group.line = inkPath('edge-line');
        group.secondaryLine = inkPath('edge-line-secondary');
        group.heads = [inkPath('edge-head'), inkPath('edge-head edge-head-secondary')];
        group.leader = svgElement('path', { class: 'edge-label-leader' });
        // The semantic button bounds contain only this small label, not the
        // whole curve. Its center is painted and clickable at every angle.
        group.control = interactiveGroup('edge', edge.id);
        group.background = svgElement('rect', { class: 'edge-label-background', rx: 4, 'pointer-events': 'all' });
        group.text = svgElement('text', { class: 'edge-label', x: 0, y: 4, 'text-anchor': 'middle' });
        group.control.append(group.background, group.text);
        group.append(group.titleElement, group.hit, group.line, group.secondaryLine, ...group.heads, group.leader);
        group.addEventListener('click', () => select('edge', edge.id));
        group.control.addEventListener('focus', () => group.classList.add('is-focused'));
        group.control.addEventListener('blur', () => group.classList.remove('is-focused'));
        state.edgeElements.set(edge.id, group);
        $('edge-layer').append(group);
        // Paint small label controls above every curve/leader, but below nodes.
        $('edge-label-layer').append(group.control);
      }
      group.dataset.tone = summary.tone;
      group.control.setAttribute('aria-label', `${source.label} ${readable(edge.relation)} ${target.label}. ${summary.label}. Inspect evidence.`);
      const edgeSignature = JSON.stringify([edge.label, source.label, target.label, summary.tone, route]);
      if (group.renderSignature !== edgeSignature) {
        group.titleElement.textContent = `${source.label} → ${target.label}: ${edge.label}`;
        paintEdgeGeometry(group, route, edge.id);
        group.text.textContent = clip(edge.label, 28);
        group.renderSignature = edgeSignature;
      }
    }
    for (const node of graph.nodes) {
      let group = state.nodeElements.get(node.id);
      if (group && Boolean(group.isSceneGroup) !== Boolean(node.isGroup)) { group.remove(); state.nodeElements.delete(node.id); group = null; }
      if (node.isGroup) {
        if (!group) {
          group = interactiveGroup('node', node.id);
          group.isSceneGroup = true;
          group.setAttribute('class', 'diagram-group');
          state.nodeElements.set(node.id, group);
          $('group-layer').append(group);
        }
        group.setAttribute('transform', `translate(${node.x} ${node.y})`);
        group.activityAria = `${node.label}. ${node.memberCount} members. ${node.collapsed ? 'Collapsed' : 'Expanded'}. Inspect evidence.`;
        group.setAttribute('aria-label', group.activityAria);
        group.dataset.change = node.style || 'default';
        const toggle = svgElement('g', { class: 'group-toggle', role: 'button', tabindex: 0,
          'aria-label': `${node.collapsed ? 'Expand' : 'Collapse'} ${node.label}`,
          'aria-expanded': String(!node.collapsed), transform: `translate(${node.width - 33} 10)` });
        toggle.append(svgElement('rect', { width: 24, height: 24, rx: 4 }),
          svgElement('text', { x: 12, y: 18, 'text-anchor': 'middle' }, node.collapsed ? '+' : '−'));
        const toggleGroup = event => { event.stopPropagation(); platform.toggle(node.id, node.collapsed); };
        toggle.addEventListener('click', toggleGroup);
        toggle.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleGroup(event); }
        });
        const restoreToggleFocus = group.contains(document.activeElement) && document.activeElement !== group;
        group.replaceChildren(svgElement('rect', { class: 'group-frame', width: node.width, height: node.height, rx: 5 }),
          svgElement('text', { class: 'group-heading', x: 14, y: 27 }, clip(node.label, Math.max(15, Math.floor((node.width - 70) / 8)))),
          svgElement('text', { class: 'group-summary', x: 14, y: 47 }, `${node.memberCount} members`), toggle);
        if (restoreToggleFocus) toggle.focus({ preventScroll: true });
        continue;
      }
      if (!group) {
        group = interactiveGroup('node', node.id);
        const center = svgElement('g', { transform: `translate(${NODE_WIDTH / 2} ${NODE_HEIGHT / 2})` });
        group.visual = svgElement('g', { class: 'node-visual' });
        group.content = svgElement('g', { transform: `translate(${-NODE_WIDTH / 2} ${-NODE_HEIGHT / 2})` });
        group.visual.append(group.content);
        center.append(group.visual);
        group.append(
          svgElement('title', {}, node.label),
          svgElement('rect', { class: 'node-hit', width: NODE_WIDTH, height: NODE_HEIGHT, 'pointer-events': 'all' }),
          center,
          svgElement('rect', { class: 'selection-ring', x: -7, y: -7, width: NODE_WIDTH + 14, height: NODE_HEIGHT + 14, rx: 14 }),
        );
        group.setAttribute('transform', `translate(${node.x} ${node.y})`);
        state.nodeElements.set(node.id, group);
        $('node-layer').append(group);
      }
      const summary = claimSummary(node);
      group.dataset.tone = summary.tone;
      group.setAttribute('transform', `translate(${node.x} ${node.y})`);
      group.dataset.shape = node.shape;
      group.dataset.kind = node.kind;
      group.dataset.change = node.style || 'default';
      group.activityAria = `${node.label}. ${upperFirst(node.kind)}. ${summary.label}. Activity ${node.activityState}. Inspect evidence.`;
      group.setAttribute('aria-label', group.activityAria);
      group.activitySignature = null;
      const nodeSignature = JSON.stringify([node.label, node.shape, node.kind, node.activityState, summary]);
      if (group.renderSignature === nodeSignature) continue;
      const titleLines = nodeTitleLines(node.label, node.shape);
      const titleWidth = nodeTitleWidth(node.shape);
      const titleViewport = svgElement('svg', {
        class: 'node-title-viewport', x: (NODE_WIDTH - titleWidth) / 2, y: 38,
        width: titleWidth, height: 34, viewBox: `0 0 ${titleWidth} 34`,
        overflow: 'hidden', 'pointer-events': 'none', 'aria-hidden': 'true',
      });
      const title = svgElement('text', { class: 'node-title', 'text-anchor': 'middle' });
      titleLines.forEach((line, index) => title.append(svgElement('tspan', {
        x: titleWidth / 2, y: titleLines.length === 1 ? 23 : 13 + index * 16,
      }, line)));
      titleViewport.append(title);
      const children = [
        ...shape(node),
        sketch(node),
        svgElement('text', { class: 'node-role', x: NODE_WIDTH / 2, y: node.shape === 'cylinder' ? 20 : 36, 'text-anchor': 'middle' }, upperFirst(node.kind)),
        titleViewport,
        svgElement('text', { class: 'node-state', x: NODE_WIDTH / 2, y: titleLines.length === 1 ? 85 : 91, 'text-anchor': 'middle' }, clip(summary.label, 26)),
      ];
      if (['pending', 'running', 'failed', 'interrupted'].includes(node.activityState)) {
        children.push(svgElement('circle', { class: 'node-activity', 'data-state': node.activityState, cx: NODE_WIDTH - 12, cy: 12, r: 4 }));
      }
      group.querySelector('title').textContent = node.label;
      group.content.replaceChildren(...children);
      group.renderSignature = nodeSignature;
    }
    updateSelection();
    $('revision').textContent = `Revision ${graph.revision}`;
    $('canvas-title').textContent = state.platformActive ? state.viewName : state.replayFrame ? 'Architecture replay' : 'Live architecture';
    $('diagram-title').textContent = `${state.replayFrame ? 'Historical' : 'Live'} architecture, revision ${graph.revision}`;
    $('diagram-desc').textContent = `${graph.nodes.length} components and ${graph.edges.length} relationships. Code interpretation does not establish runtime connectivity. Use Tab and Enter to inspect a component or relationship. With the diagram focused, use plus and minus to zoom, arrow keys to pan, and 0 to fit.`;
    $('graph-count').textContent = `${graph.nodes.length} components · ${graph.edges.length} relationships`;
    $('diagram-search-status').textContent = state.searchQuery || state.nodeTypes !== null
      ? `${graph.nodes.length} of ${canonical.nodes.length} components shown` : '';
    $('diagram-search-clear').hidden = !state.searchQuery;
    $('empty-canvas').hidden = graph.nodes.length > 0 || removalBounds().length > 0;
    const classifier = state.snapshot.paused ? 'paused' : state.snapshot.status.classifier;
    const emptyMessages = {
      metadata_only: ['Activity is live. The map is waiting.', 'This session captures metadata only. Enable source interpretation in the local service to build an evidence-backed architecture.'],
      missing_key: ['Ready for a classifier.', 'Captured activity appears below. Configure the classifier in the local service to interpret permitted source evidence.'],
      paused: ['Classification is paused.', 'Capture and evidence invalidation continue. Resume classification to interpret new evidence.'],
      unavailable: ['Waiting for classification.', 'The classifier is unavailable. Safe activity continues below; supported architecture will appear when classification recovers.'],
      timeout: ['Evidence needs another moment.', 'Classification exceeded its deadline. Activity still appears below, and no unsupported components are added.'],
    };
    const message = state.nodeTypes?.size === 0
      ? ['No component types selected.', 'Choose a type or All types to show components.']
      : state.searchQuery
      ? ['No matching components.', `No selected components match “${state.searchQuery}”. Try another search or press Esc to clear the search.`]
      : state.nodeTypes !== null && canonical.nodes.length
      ? ['No matching components.', 'Choose another type or All types to show components.']
      : state.replayFrame
      ? ['No components in this revision.', 'Move through the recent revisions or return to Live to follow the current map.']
      : state.platformActive && state.viewName === 'Blocks'
      ? ['Waiting for files in this scope.', 'File reading and editing activity appears locally, without a classification key. Open another source scope or let your agent work.']
      : emptyMessages[classifier] || ['Your architecture starts here.', 'Work in a connected agent session. Components appear when approved evidence supports them; activity can arrive first.'];
    $('empty-title').textContent = message[0];
    $('empty-description').textContent = message[1];
    refreshToolActivity();
  }
  function paintEdgeGeometry(group, route, id) {
    const ink = sketchConnection(route.points, id);
    group.hit.setAttribute('d', route.d);
    [group.line, group.secondaryLine].forEach((path, index) => path.setAttribute('d', ink.lines[index] || ''));
    group.heads.forEach((path, index) => path.setAttribute('d', ink.heads[index] || ''));
    group.leader.setAttribute('d', route.leader || '');
    group.control.setAttribute('transform', `translate(${route.x} ${route.y}) rotate(${route.angle})`);
    // A near pair can cross the threshold for moving its label off the curve.
    // Keep the same compact semantic control throughout the interpolation.
    group.background.setAttribute('x', -route.labelWidth / 2);
    group.background.setAttribute('y', -route.labelHeight / 2);
    group.background.setAttribute('width', route.labelWidth);
    group.background.setAttribute('height', route.labelHeight);
  }
  function paintGeometry(graph) {
    for (const node of graph.nodes) {
      state.nodeElements.get(node.id)?.setAttribute('transform', `translate(${node.x} ${node.y})`);
    }
    for (const [id, route] of graphEdgeRoutes(graph)) {
      const group = state.edgeElements.get(id);
      if (!group) continue;
      paintEdgeGeometry(group, route, id);
    }
  }
  function moveLayout(before, after) {
    if (!before || !motionAllowed() || !window.requestAnimationFrame || after.nodes.length > 80 || after.edges.length > 160) return;
    const from = new Map(before.nodes.map(node => [node.id, node]));
    if (!after.nodes.some(node => from.has(node.id) && (from.get(node.id).x !== node.x || from.get(node.id).y !== node.y))) return;
    // Very distant original coordinates should settle immediately. Nearby
    // layouts keep both endpoints visible throughout their interpolation.
    const viewport = state.viewport;
    const visible = before.nodes.some(node => node.x < viewport.x + viewport.width &&
      node.x + NODE_WIDTH > viewport.x && node.y < viewport.y + viewport.height &&
      node.y + NODE_HEIGHT > viewport.y);
    if (!visible) return;
    const fitAfter = graphBounds(after);
    const fitDuring = combinedBounds(graphBounds(before), fitAfter);
    fitCamera(fitDuring);
    const movement = { start: null, frame: null, timer: null, fitAfter, fitDuring };
    state.movement = movement;
    const paint = progress => paintGeometry({ ...after, nodes: after.nodes.map(node => {
      const old = from.get(node.id) || node;
      return { ...node, x: old.x + (node.x - old.x) * progress, y: old.y + (node.y - old.y) * progress };
    }) });
    paint(0);
    const tick = now => {
      if (state.movement !== movement) return;
      if (!motionAllowed()) { cancelMovement(); return; }
      if (movement.start === null) movement.start = now;
      const progress = Math.max(0, Math.min(1, (now - movement.start) / 250));
      paint(1 - (1 - progress) ** 3);
      if (progress < 1) movement.frame = window.requestAnimationFrame(tick);
      else cancelMovement();
    };
    movement.frame = window.requestAnimationFrame(tick);
    movement.timer = setTimeout(() => { if (state.movement === movement) cancelMovement(); }, 350);
  }
  function arrange() {
    const graph = currentGraph();
    if (!graph) return;
    finishPan();
    cancelMovement();
    const before = state.displayGraph;
    renderGraph({ forceFit: true, arrange: true });
    moveLayout(before, state.displayGraph);
    announce(`Arranged using ${LAYOUT_NAMES[state.view.algorithm]}. Evidence and selection are unchanged.`);
  }
  function fact(list, label, value) {
    const row = html('div');
    row.append(html('dt', label), html('dd', value));
    list.append(row);
  }
  function renderInspector() {
    const body = $('inspector-body');
    const graph = currentGraph();
    const selected = state.selection;
    let claim = selected && graph ? (selected.type === 'node' ? graph.nodes : graph.edges).find(item => item.id === selected.id) : null;
    if (!claim && state.platformActive && selected?.type === 'node') {
      const entity = state.model.entities.find(entity => entity.id === selected.id);
      if (entity) claim = sceneGraph({ groups: [], edges: [], nodes: [{ id: entity.id, entityId: entity.id, label: entity.label, kind: entity.kind }] }, state.model).nodes[0];
    }
    const linkedIds = new Set(claim?.sourceRefs.map(ref => ref.eventId) || []);
    const related = state.snapshot?.activity.filter(event => linkedIds.has(event.id)).slice(-5).reverse() || [];
    const override = selected?.type === 'node' ? state.view?.shapes.get(selected.id) : undefined;
    const signature = JSON.stringify([selected, claim, Boolean(state.replayFrame), state.replayFrame?.revision, related, override]);
    if (state.inspectorSignature === signature) return;
    state.inspectorSignature = signature;
    $('clear-selection').hidden = !selected;
    if (!selected || !graph) {
      const empty = html('div', undefined, 'inspector-empty');
      empty.append(html('span', '↗', 'inspector-glyph'), html('h3', 'Every connection has a reason.'), html('p', 'Select a component or an arrow to see its classification, confidence, and source references.'), html('p', 'Use Tab to reach diagram items, then Enter to inspect.', 'inspector-hint'));
      body.replaceChildren(empty);
      return;
    }
    if (!claim) {
      body.replaceChildren(html('h3', 'Selection left this revision.'), html('p', 'Its supporting evidence may have changed or been retracted. Use replay to inspect earlier revisions, or select another component.'));
      return;
    }
    const summary = claimSummary(claim);
    const type = html('div', selected.type === 'node' ? `${upperFirst(claim.kind)} component` : `${upperFirst(readable(claim.relation))} relationship`, 'claim-type');
    const badges = html('div', undefined, 'claim-badges');
    const badge = html('span', summary.label, 'badge');
    badge.dataset.tone = summary.tone;
    badges.append(badge);
    if (state.replayFrame) badges.append(html('span', `Replay · revision ${graph.revision}`, 'badge'));
    const facts = html('dl', undefined, 'evidence-facts');
    fact(facts, 'Classification', upperFirst(claim.classification));
    fact(facts, 'Validity', upperFirst(claim.validity));
    fact(facts, 'Evidence state', claim.evidenceState === 'verified' ? 'Verification reported; scope unavailable' : upperFirst(claim.evidenceState));
    const interpreted = claim.sourceRefs.length && claim.sourceRefs.every(ref => INTERPRETATION_BASES.includes(ref.basis));
    const interpretationLabel = claim.sourceRefs.some(ref => ref.basis === 'decision_interpretation') ? 'Decision interpretation' : 'Jev code interpretation';
    fact(facts, 'Basis', claim.basis ? upperFirst(claim.basis) : interpreted ? interpretationLabel : 'Provenance incomplete');
    fact(facts, 'Runtime', 'Not established by this snapshot');
    if (selected.type === 'node') fact(facts, 'Activity', upperFirst(claim.activityState));
    else {
      fact(facts, 'From', graph.nodes.find(node => node.id === claim.source)?.label || 'Unknown component');
      fact(facts, 'To', graph.nodes.find(node => node.id === claim.target)?.label || 'Unknown component');
    }
    body.replaceChildren(type, html('h3', claim.label), badges, html('p', summary.explanation), facts);
    if (state.platformActive && selected.type === 'node') {
      fact(facts, 'Change', readable(claim.style || 'No comparison'));
      if (claim.memberCount) fact(facts, 'Members', String(claim.memberCount));
      const openScope = html('button', 'Open source scope');
      openScope.setAttribute('type', 'button');
      openScope.addEventListener('click', () => platform.scope(claim.entityId || claim.id));
      body.append(openScope);
    } else if (claim.relationIds?.length) fact(facts, 'Supporting relations', claim.relationIds.join(', '));
    if (selected.type === 'node') {
      const label = html('label', 'Shape · visual only', 'shape-picker');
      label.setAttribute('for', 'display-shape');
      const selectShape = html('select');
      selectShape.setAttribute('id', 'display-shape');
      selectShape.setAttribute('aria-describedby', 'shape-note');
      for (const [value, name] of [['automatic', 'Automatic'], ...Object.entries(SHAPE_NAMES)]) {
        const option = html('option', name);
        option.value = value;
        selectShape.append(option);
      }
      // Old records retain their valid shape. Explicit Automatic opts into the
      // current role mapping; no stored claim is rewritten.
      selectShape.value = override || (claim.shape === ROLE_SHAPES[claim.kind] ? 'automatic' : claim.shape);
      label.append(selectShape);
      const note = html('p', `Appearance only. Automatic uses ${SHAPE_NAMES[ROLE_SHAPES[claim.kind]].toLowerCase()} for ${claim.kind}.`, 'fine-print');
      note.setAttribute('id', 'shape-note');
      body.append(label, note);
      const scopeKey = state.viewKey;
      selectShape.addEventListener('change', () => {
        if (state.viewKey !== scopeKey || ![...SHAPES, 'automatic'].includes(selectShape.value)) return;
        finishPan();
        state.view.shapes.delete(claim.id);
        state.view.shapes.set(claim.id, selectShape.value);
        while (state.view.shapes.size > LIMITS.nodes) state.view.shapes.delete(state.view.shapes.keys().next().value);
        cancelMovement();
        finishEffect(claim.id);
        renderGraph();
        // Preserve the focused select and open evidence disclosures.
        state.inspectorSignature = JSON.stringify([selected, claim, Boolean(state.replayFrame), state.replayFrame?.revision, related, selectShape.value]);
        announce(`Display shape changed. ${claim.label} remains classified as ${claim.kind}.`);
      });
    }
    if (!['parsed', 'metadata', 'lexical'].includes(claim.basis)) {
      const confidence = normalizeConfidence(claim.confidence);
      body.append(html('h4', 'Classifier confidence'));
      const confidenceList = html('ul', undefined, 'confidence-list');
      const confidenceLabels = {
        supportProbability: 'Evidence support probability',
        roleProbability: 'Selected role probability',
        roleConfidence: 'Role distribution confidence',
        missingContextProbability: 'Missing-context probability',
        reportedConfidence: 'Reported classifier confidence',
      };
      for (const key of Object.keys(confidenceLabels)) {
        if (!probability(confidence[key])) continue;
        const item = html('li');
        item.append(html('span', confidenceLabels[key]), html('strong', `${(confidence[key] * 100).toFixed(1)}%`));
        confidenceList.append(item);
      }
      if (confidenceList.childElementCount) body.append(confidenceList);
      else body.append(html('p', 'Confidence was not supplied for this claim.', 'fine-print'));
      body.append(html('p', 'These values describe the classifier’s interpretation. They are not measured accuracy or the probability that a runtime connection succeeds.', 'fine-print'));
      if (record(confidence.roleProbabilities)) {
        const details = html('details');
        details.append(html('summary', 'Role probabilities'));
        const list = html('ul', undefined, 'confidence-list');
        for (const [role, value] of Object.entries(confidence.roleProbabilities)) {
          const row = html('li');
          row.append(html('span', upperFirst(role)), html('strong', `${(value * 100).toFixed(1)}%`));
          list.append(row);
        }
        details.append(list);
        body.append(details);
      }
    }
    body.append(html('h4', `Source references (${claim.sourceRefs.length})`));
    if (!claim.sourceRefs.length) body.append(html('p', 'No source references were supplied. This claim’s provenance cannot be inspected.', 'fine-print'));
    const refs = html('ol', undefined, 'source-list');
    for (const ref of claim.sourceRefs) {
      const item = html('li', undefined, 'source-reference');
      item.append(
        html('strong', ref.sourceClass === 'public_intent' ? 'Public intent' : ref.sourceClass === 'source' || (claim.basis === 'parsed' && ref.artifactId) ? 'Source artifact' : 'Unknown source class'),
        html('span', claim.basis ? `Basis: ${upperFirst(claim.basis)}` : ref.basis === 'decision_interpretation'
          ? 'Basis: Decision interpretation' : ref.basis === 'jev_interpretation' ? 'Basis: Jev interpretation' : 'Basis not supplied'),
        html('span', `${ref.sourceClass === 'public_intent' ? 'Message' : 'Artifact'}: ${ref.sourceRef?.messageId || ref.artifactId || 'not supplied'}`),
        html('span', `Version: ${ref.hash || 'not supplied'} · ${ref.sourceClass === 'public_intent' ? 'content version' : 'generation'} ${ref.sourceRef?.contentVersion ?? ref.generation}`),
      );
      if (ref.startLine > 0) item.append(html('span', ref.endLine >= ref.startLine ? `Lines ${ref.startLine}–${ref.endLine}` : `Line ${ref.startLine}`));
      if (ref.eventId) item.append(html('span', `Event: ${ref.eventId}`));
      if (ref.excerpt) {
        const details = html('details');
        details.append(html('summary', 'Approved excerpt'), html('pre', ref.excerpt));
        item.append(details);
      } else item.append(html('span', 'Excerpt unavailable or withheld by display policy.'));
      refs.append(item);
    }
    body.append(refs);
    if (related.length) {
      body.append(html('h4', 'Related captured activity'));
      for (const event of related) {
        const button = html('button', `${event.label} · ${upperFirst(event.state)}`, 'related-event');
        button.type = 'button';
        button.addEventListener('click', () => {
          const row = state.activityElements.get(event.id);
          if (row) {
            setWorkspacePanel('activity', true);
            row.querySelector('button').focus();
            row.scrollIntoView({ block: 'nearest' });
          }
        });
        body.append(button);
      }
      body.append(html('p', 'A successful tool outcome does not verify this architecture.', 'fine-print'));
    }
  }
  function renderHistory() {
    if (state.platformActive) {
      const replay = Boolean(platform.selection.checkpoint);
      $('live').setAttribute('aria-pressed', String(!replay));
      $('replay').setAttribute('aria-pressed', String(replay));
      $('history-position').textContent = `Rev. ${state.model.revision}`;
      $('replay-note').textContent = replay ? 'Recorded checkpoint. Choose Live to return to current observations.'
        : 'Use Position to inspect a retained model checkpoint.';
      $('activity-note').textContent = 'This panel shows live capture. The timeline follows the selected model position.';
      return;
    }
    const replay = Boolean(state.replayFrame);
    const frameIndex = replay ? state.frames.findIndex(frame => frame.revision === state.replayFrame.revision) : state.frames.length - 1;
    $('live').setAttribute('aria-pressed', String(!replay));
    $('replay').setAttribute('aria-pressed', String(replay));
    $('history').max = String(Math.max(0, state.frames.length - 1));
    $('history').value = String(Math.max(0, frameIndex));
    const revision = currentGraph()?.revision ?? 0;
    $('history').setAttribute('aria-valuetext', `Revision ${revision}${replay ? ', replay' : ', live'}`);
    $('history-position').textContent = state.snapshot ? `Rev. ${revision}` : 'No history';
    $('replay-note').textContent = replay
      ? frameIndex < 0 ? 'Pinned revision aged out of recent history. Activity stays live.' : `Historical graph${state.replayFrame.at === null ? '' : ` at ${formatTime(state.replayFrame.at)}`}. Activity stays live.`
      : `${state.frames.length} recent ${state.frames.length === 1 ? 'revision' : 'revisions'}. Live follows the latest snapshot.`;
    $('activity-note').textContent = replay ? 'Live activity continues while you inspect a historical graph.' : 'Observable work, independent of classification.';
  }
  function renderActivity() {
    const events = [...state.snapshot.activity].sort((a, b) => b.sequence - a.sequence || (b.at || 0) - (a.at || 0));
    const ids = new Set(events.map(event => event.id));
    for (const [id, row] of state.activityElements) if (!ids.has(id)) { row.remove(); state.activityElements.delete(id); }
    const selectedGraph = currentGraph();
    const selected = state.selection;
    const selectedClaim = selected ? (selected.type === 'node' ? selectedGraph.nodes : selectedGraph.edges).find(item => item.id === selected.id) : null;
    const relatedIds = new Set(selectedClaim?.sourceRefs.map(ref => ref.eventId) || []);
    for (const [index, event] of events.entries()) {
      let row = state.activityElements.get(event.id);
      if (!row) {
        row = html('li', undefined, 'activity-item');
        state.activityElements.set(event.id, row);
      }
      row.classList.toggle('is-focused', relatedIds.has(event.id));
      const expectedPosition = $('activity-list').children[index];
      if (expectedPosition !== row) $('activity-list').insertBefore(row, expectedPosition || null);
      const eventSignature = JSON.stringify(event);
      if (row.renderSignature === eventSignature) continue;
      const button = html('button', undefined, 'activity-row');
      button.type = 'button';
      const time = html('time', event.at === null ? '—' : formatTime(event.at));
      if (event.at !== null) time.dateTime = new Date(event.at).toISOString();
      time.title = formatTime(event.at, true);
      const dot = html('span', undefined, 'event-dot');
      dot.dataset.state = event.state;
      dot.setAttribute('aria-hidden', 'true');
      button.append(time, dot, html('span', event.label, 'event-title'), html('span', event.incomplete ? 'Incomplete capture' : event.toolCategory ? readable(event.toolCategory) : 'Captured event', 'event-detail'), html('span', upperFirst(event.state), 'event-state'));
      button.setAttribute('aria-label', `${event.label}. ${event.state}${event.incomplete ? '. Incomplete capture' : ''}. Inspect related evidence.`);
      button.addEventListener('click', () => {
        const graph = currentGraph();
        const node = graph.nodes.find(item => item.sourceRefs.some(ref => ref.eventId === event.id));
        const edge = graph.edges.find(item => item.sourceRefs.some(ref => ref.eventId === event.id));
        if (node || edge) {
          state.selection = { type: node ? 'node' : 'edge', id: (node || edge).id };
          updateSelection();
          renderInspector();
          renderActivity();
          revealInspector();
          announce(`Related evidence for ${(node || edge).label} is shown in the inspector.`);
        } else toast(state.replayFrame ? 'No evidence link for this event in the displayed revision. Return to Live to inspect current links.' : 'This captured event has no architecture evidence link. Tool activity alone does not establish an architectural claim.');
      });
      const focused = row.contains(document.activeElement);
      row.replaceChildren(button);
      row.renderSignature = eventSignature;
      if (focused) button.focus({ preventScroll: true });
    }
    $('activity-count').textContent = `${events.length} recent ${events.length === 1 ? 'event' : 'events'}`;
    $('activity-empty').hidden = events.length > 0;
    $('activity-list').hidden = events.length === 0;
  }
  function render(graphOptions) {
    renderStatus();
    renderOnboarding();
    renderGraph(graphOptions);
    renderInspector();
    renderHistory();
    renderActivity();
    renderSidebar();
    updateControls();
  }
  function renderSidebar() {
    if (state.snapshot) sidebar.update(state.snapshot, {
      replay: Boolean(state.replayFrame), theme: token(state.view?.theme, THEMES, 'sketchbook'),
    });
  }
  function replayAt(index) {
    const frame = state.frames[index];
    if (!frame) return;
    setWorkspacePanel('history', true);
    resetMotionBaseline();
    state.replayFrame = frame;
    render();
    announce(`Showing architecture revision ${frame.revision}. Activity remains live.`);
  }
  async function refresh() {
    const epoch = state.epoch;
    const raw = await request('/api/state');
    if (epoch === state.epoch) acceptSnapshot(raw);
  }
  async function control(action, sessionId) {
    if (state.busy) return;
    state.busy = true;
    if (action === 'session') resetMotionBaseline();
    error();
    updateControls();
    try {
      await request('/api/control', { method: 'POST', body: JSON.stringify(sessionId ? { action, sessionId } : { action }) });
      await refresh();
      announce(action === 'pause' ? 'Classification paused. Capture and evidence invalidation continue.' : action === 'resume' ? 'Classification resumed.' : 'Session selected.');
    } catch (cause) {
      if (cause.message === 'auth_required') connection('auth');
      error('The control was not confirmed. Reconnect and check the current state before trying again.');
      if (state.snapshot) $('session').value = state.snapshot.sessionId;
    } finally { state.busy = false; updateControls(); }
  }
  async function connect() {
    resetMotionBaseline();
    platform.suspend();
    const attempt = ++state.connectEpoch;
    projectController?.abort();
    projectController = null;
    state.stream?.close();
    state.stream = null;
    connection('connecting');
    error();
    try {
      await exchangeLaunchToken({ location: window.location, history: window.history, request });
      const raw = await request('/api/state');
      if (attempt !== state.connectEpoch) return;
      acceptSnapshot(raw);
      const stream = new EventSource('/api/events', { withCredentials: true });
      state.stream = stream;
      stream.addEventListener('open', () => { if (state.stream === stream) connection('connected'); });
      stream.addEventListener('snapshot', event => {
        if (state.stream !== stream) return;
        try {
          if (event.data.length > MAX_JSON_BYTES) throw new Error('response_too_large');
          acceptSnapshot(JSON.parse(event.data), true);
          connection('connected');
          error();
        } catch {
          resetMotionBaseline();
          error('An invalid snapshot was ignored. The last accepted view is retained; a complete snapshot will restore the live view.');
        }
      });
      stream.addEventListener('error', () => {
        if (state.stream !== stream) return;
        resetMotionBaseline();
        connection('reconnecting');
        error('The live connection was lost. Displaying the last received snapshot while the viewer reconnects.');
      });
      void platform.start();
      void dashboardInfo.refresh();
      // Optional authenticated metadata must not hold up the event stream or
      // turn an older server's missing endpoint into a connection failure.
      const controller = new AbortController();
      projectController = controller;
      try {
        const info = normalizeConnectionInfo(await request('/api/connection-info', { signal: controller.signal }));
        if (!state.closed && attempt === state.connectEpoch) {
          state.projectName = friendlyProjectName(info.projectRoot);
          $('project-path').textContent = info.projectRoot;
          $('project-path').title = info.projectRoot;
          renderStatus();
        }
      } catch { /* The project ID remains a usable fallback. */ }
      finally { if (projectController === controller) projectController = null; }
    } catch (cause) {
      if (attempt !== state.connectEpoch) return;
      const auth = cause.message === 'auth_required' || cause.message === 'invalid_launch';
      connection(auth ? 'auth' : 'error');
      error(auth
        ? 'This launch link is invalid, expired, or already used. Open a fresh viewer link from the local Graphlin service.'
        : 'The local service could not provide a snapshot. Check that Graphlin is running, then reconnect.');
    }
  }
  async function exportJSON() {
    if (state.exporting) return;
    state.exporting = true;
    updateControls();
    try {
      const exported = sanitizedExport(await request('/api/export'));
      const blob = new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = html('a');
      link.href = url;
      link.download = 'graphlin-current-snapshot.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Exported the current server snapshot. Source excerpts are omitted, including from history.');
    } catch {
      error('The snapshot could not be exported. Check the connection and try again.');
    } finally { state.exporting = false; updateControls(); }
  }

  $('retry').addEventListener('click', connect);
  const onOnboardingAction = () => {
    if (state.closed) return;
    const action = $('onboarding-action').dataset.action;
    if (action === 'reconnect') return connect();
    if (action === 'resume') return control('resume');
    if (action === 'diagnostics') return diagnosticsDialog.open();
    return connectionDialog.open();
  };
  const onCopyOrientation = async () => {
    try {
      if (!window.navigator?.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await window.navigator.clipboard.writeText(ORIENTATION_PROMPT);
      if (!state.closed) $('orientation-copy-status').textContent = 'Copied. Paste this prompt into your connected agent.';
    } catch {
      if (state.closed) return;
      $('orientation-copy-status').textContent = 'Select the prompt text and copy it manually.';
      $('orientation-prompt').focus();
    }
  };
  const workspacePanels = {
    details: { panel: $('live-sidebar'), toggle: $('details-toggle') },
    history: { panel: $('history-panel'), toggle: $('history-toggle') },
    activity: { panel: $('activity-panel'), toggle: $('activity-toggle') },
  };
  function setWorkspacePanel(name, open) {
    const { panel, toggle } = workspacePanels[name];
    if (!open && panel.contains(document.activeElement)) toggle.focus();
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (name === 'details') $('workspace-body').dataset.detailsOpen = String(open);
    if (name === 'activity') $('activity-content').hidden = !open;
  }
  const onToggleDetails = () => setWorkspacePanel('details', $('live-sidebar').hidden);
  const onToggleHistory = () => setWorkspacePanel('history', $('history-panel').hidden);
  const onToggleActivity = () => setWorkspacePanel('activity', $('activity-panel').hidden);
  const onCloseDetails = () => {
    setWorkspacePanel('details', false);
    $('details-toggle').focus();
  };
  const onViewUpdate = () => {
    $('version-update-guide').open = !$('version-update-guide').hidden;
    revealDetailsSection($('version-update-status'));
  };
  const panelKeyHandlers = new Map();
  for (const [name, { panel, toggle }] of Object.entries(workspacePanels)) {
    setWorkspacePanel(name, false);
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.target?.tagName?.toLowerCase() === 'select') return;
      event.preventDefault();
      setWorkspacePanel(name, false);
      toggle.focus();
    };
    panel.addEventListener('keydown', onKeyDown);
    panelKeyHandlers.set(panel, onKeyDown);
  }
  $('onboarding-action').addEventListener('click', onOnboardingAction);
  $('orientation-copy').addEventListener('click', onCopyOrientation);
  $('details-toggle').addEventListener('click', onToggleDetails);
  $('details-close').addEventListener('click', onCloseDetails);
  $('version-update-indicator').addEventListener('click', onViewUpdate);
  $('history-toggle').addEventListener('click', onToggleHistory);
  $('activity-toggle').addEventListener('click', onToggleActivity);
  const applyFilters = () => {
    if (state.platformActive) { platform.filter(state.searchQuery, state.nodeTypes); return; }
    // Filtering is not a source change: cancel existing decoration/movement
    // and render directly, without changing the snapshot arrival baseline.
    finishPan();
    clearMotion();
    renderOnboarding();
    renderGraph({ forceFit: true, arrange: true });
  };
  const onSearchInput = () => {
    if (state.closed || state.searchQuery === $('diagram-search').value) return;
    state.searchQuery = $('diagram-search').value;
    if (state.platformActive) { platform.filter(state.searchQuery, state.nodeTypes); return; }
    applyFilters();
  };
  const onNodeTypeClick = event => {
    if (state.closed || !currentGraph()) return;
    const container = $('node-type-filters');
    let button = event.target;
    while (button && button.parentElement !== container) button = button.parentElement;
    const kind = button?.dataset.kind;
    if (!kind || !state.nodeTypeButtons.has(kind)) return;
    // null means all, including future kinds. Explicit selections retain their
    // choices when a kind disappears and returns; new kinds stay unselected.
    if (state.nodeTypes === null) state.nodeTypes = new Set((state.platformActive ? state.model.entities : currentGraph().nodes).map(node => node.kind));
    if (state.nodeTypes.has(kind)) state.nodeTypes.delete(kind);
    else state.nodeTypes.add(kind);
    applyFilters();
  };
  const onAllNodeTypes = () => {
    if (state.closed) return;
    state.nodeTypes = null;
    applyFilters();
  };
  const onNoNodeTypes = () => {
    if (state.closed) return;
    state.nodeTypes = new Set();
    applyFilters();
  };
  const clearSearch = () => {
    $('diagram-search').value = '';
    onSearchInput();
    $('diagram-search').focus({ preventScroll: true });
  };
  const onSearchKeyDown = event => {
    if (state.closed || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
      $('diagnostics-dialog').open || $('connection-dialog').open || document.querySelector?.('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    const target = event.target || document.activeElement;
    if (target !== $('diagram-search') && isSearchTypingTarget(target)) return;
    if (event.key === '/' && target !== $('diagram-search')) {
      event.preventDefault();
      $('diagram-search').focus({ preventScroll: true });
    } else if (event.key === 'Escape' && state.searchQuery) {
      event.preventDefault();
      clearSearch();
    }
  };
  $('diagram-search').addEventListener('input', onSearchInput);
  $('diagram-search-clear').addEventListener('click', clearSearch);
  $('node-type-filters')?.addEventListener('click', onNodeTypeClick);
  $('node-types-all')?.addEventListener('click', onAllNodeTypes);
  $('node-types-none')?.addEventListener('click', onNoNodeTypes);
  window.addEventListener('keydown', onSearchKeyDown);
  $('pause').addEventListener('click', () => control(state.snapshot?.paused ? 'resume' : 'pause'));
  $('session').addEventListener('change', () => state.platformActive ? platform.session($('session').value) : control('session', $('session').value));
  $('export').addEventListener('click', exportJSON);
  $('live').addEventListener('click', () => {
    if (state.platformActive) { platform.live(); return; }
    resetMotionBaseline();
    state.replayFrame = null;
    if (state.snapshot) render();
    announce('Following the live architecture.');
  });
  $('replay').addEventListener('click', () => replayAt(Math.max(0, state.frames.length - 2)));
  $('history').addEventListener('input', () => replayAt(Number($('history').value)));
  $('clear-selection').addEventListener('click', () => {
    state.selection = null;
    updateSelection();
    renderInspector();
    renderActivity();
  });
  $('fit').addEventListener('click', fitGraph);
  $('arrange').addEventListener('click', arrange);
  $('layout').addEventListener('change', () => {
    if (!state.view || !LAYOUT_ALGORITHMS.includes($('layout').value)) return;
    finishPan();
    state.view.algorithm = $('layout').value;
    arrange();
  });
  $('theme').addEventListener('change', () => {
    if (!state.view || !THEMES.includes($('theme').value)) { applyTheme(); return; }
    state.view.theme = $('theme').value;
    // Recolor through inherited CSS only. Selection, evidence, motion timers,
    // layout interpolation, camera and graph DOM remain undisturbed.
    applyTheme();
    renderSidebar();
    announce(`${THEME_NAMES[state.view.theme]} theme applied.`);
  });
  $('auto-arrange').addEventListener('change', () => {
    if (!state.view) return;
    finishPan();
    state.view.auto = $('auto-arrange').checked;
    if (state.view.auto) arrange();
    else renderGraph();
  });
  $('zoom-in').addEventListener('click', () => zoom(1.25));
  $('zoom-out').addEventListener('click', () => zoom(.8));
  const onDiagramWheel = event => {
    if (state.closed || !state.viewport || !currentGraph()?.nodes.length || event.defaultPrevented ||
      event.shiftKey || !Number.isFinite(event.deltaY) || event.deltaY === 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const rect = $('architecture').getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) ||
      !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    // Wheel units are pixels, lines, or pages. Keep trackpad motion continuous,
    // but cap each event so a coarse wheel or a page delta cannot jump too far.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
    const box = state.viewport;
    const scale = Math.min(rect.width / box.width, rect.height / box.height);
    const width = box.width * scale, height = box.height * scale;
    const anchor = {
      x: (event.clientX - rect.left - (rect.width - width) / 2) / width,
      y: (event.clientY - rect.top - (rect.height - height) / 2) / height,
    };
    event.preventDefault();
    zoom(Math.exp(-delta * .002), anchor);
  };
  $('architecture').addEventListener('wheel', onDiagramWheel, { passive: false });
  $('architecture').addEventListener('keydown', event => {
    if (event.target !== $('architecture')) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    else if (event.key === '-') { event.preventDefault(); zoom(.8); }
    else if (event.key === '0') { event.preventDefault(); fitGraph(); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && state.viewport) {
      event.preventDefault();
      cancelMovement();
      finishPan();
      const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      state.viewport.x += move[0] * state.viewport.width * .1;
      state.viewport.y += move[1] * state.viewport.height * .1;
      state.followFit = false;
      state.manualCamera = true;
      setViewBox();
    }
  });
  $('architecture').addEventListener('pointerdown', event => {
    if (state.closed || !state.viewport || event.button !== 0 || !currentGraph()?.nodes.length ||
      event.target.closest('[role="button"]') || event.target.closest('.diagram-edge')) return;
    cancelMovement();
    finishPan();
    pointer = { x: event.clientX, y: event.clientY, view: { ...state.viewport }, id: event.pointerId };
    $('architecture').setPointerCapture(event.pointerId);
    $('architecture').classList.add('is-panning');
  });
  $('architecture').addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const rect = $('architecture').getBoundingClientRect();
    const scale = Math.max(pointer.view.width / Math.max(1, rect.width), pointer.view.height / Math.max(1, rect.height));
    state.viewport.x = pointer.view.x - (event.clientX - pointer.x) * scale;
    state.viewport.y = pointer.view.y - (event.clientY - pointer.y) * scale;
    state.followFit = false;
    state.manualCamera = true;
    setViewBox();
  });
  function finishPan() {
    const active = pointer;
    pointer = null;
    const canvas = $('architecture');
    canvas.classList.remove('is-panning');
    if (active && canvas.hasPointerCapture?.(active.id)) canvas.releasePointerCapture(active.id);
  }
  $('architecture').addEventListener('pointerup', finishPan);
  $('architecture').addEventListener('pointercancel', finishPan);
  $('architecture').addEventListener('lostpointercapture', finishPan);
  const onPageHide = () => { connectionDialog.close(); diagnosticsDialog.close(); platform.suspend(); resetMotionBaseline(); state.stream?.close(); state.stream = null; };
  const onPageShow = event => { if (!state.closed && event.persisted) connect(); };
  const onOnline = () => { if (!state.closed && state.connection !== 'connected') connect(); };
  const onVisibility = () => resetMotionBaseline();
  const onMotionPreference = () => { if (motionPreference.matches) resetMotionBaseline(); };
  const onResize = () => {
    if (state.closed || !state.displayGraph) return;
    const rect = $('architecture').getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const nextSize = `${rect.width}:${rect.height}`;
    if (nextSize === canvasSize) return;
    canvasSize = nextSize;
    // The activity strip also resizes the stage. Respect the user's camera
    // for both those layout changes and actual window resizes.
    if (!state.follow || state.manualCamera) return;
    fitGraph();
  };
  const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(onResize) : null;
  resizeObserver?.observe($('diagram-stage'));
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  window.addEventListener('resize', onResize);
  document.addEventListener?.('visibilitychange', onVisibility);
  motionPreference?.addEventListener?.('change', onMotionPreference);
  for (const option of $('layout').children) option.disabled = !LAYOUT_ALGORITHMS.includes(option.value);
  renderShapeKey();
  applyTheme();
  return {
    ready: connect(),
    close() {
      state.closed = true;
      platform.close();
      projectController?.abort();
      projectController = null;
      dashboardInfo.close();
      $('onboarding-action').removeEventListener('click', onOnboardingAction);
      $('orientation-copy').removeEventListener('click', onCopyOrientation);
      $('details-toggle').removeEventListener('click', onToggleDetails);
      $('details-close').removeEventListener('click', onCloseDetails);
      $('version-update-indicator').removeEventListener('click', onViewUpdate);
      $('history-toggle').removeEventListener('click', onToggleHistory);
      $('activity-toggle').removeEventListener('click', onToggleActivity);
      for (const [panel, handler] of panelKeyHandlers) panel.removeEventListener('keydown', handler);
      $('diagram-search').removeEventListener('input', onSearchInput);
      $('diagram-search-clear').removeEventListener('click', clearSearch);
      $('node-type-filters')?.removeEventListener('click', onNodeTypeClick);
      $('node-types-all')?.removeEventListener('click', onAllNodeTypes);
      $('node-types-none')?.removeEventListener('click', onNoNodeTypes);
      window.removeEventListener?.('keydown', onSearchKeyDown);
      $('architecture').removeEventListener('wheel', onDiagramWheel);
      connectionDialog.dispose();
      diagnosticsDialog.dispose();
      sidebar.destroy();
      resizeObserver?.disconnect();
      resetMotionBaseline();
      sketches.clear();
      detailSketches.clear();
      state.connectEpoch += 1;
      state.stream?.close();
      state.stream = null;
      clearTimeout(toastTimer);
      clearTimeout(announcementTimer);
      clearTimeout(activityTimer);
      toolActivity.clear();
      document.removeEventListener?.('visibilitychange', onVisibility);
      motionPreference?.removeEventListener?.('change', onMotionPreference);
      window.removeEventListener?.('pagehide', onPageHide);
      window.removeEventListener?.('pageshow', onPageShow);
      window.removeEventListener?.('online', onOnline);
      window.removeEventListener?.('resize', onResize);
    },
  };
}

if (typeof document !== 'undefined' && document.getElementById('architecture')) startViewer();
