import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({
  paths: 32, trackedPaths: 1024, fileBytes: 256 * 1024,
  candidates: 12, snippetChars: 1800, snippetLines: 24,
  labelChars: 80, refs: 8, excerptChars: 256, graphBytes: 1024 * 1024,
  admissionBytes: 896 * 1024, nodes: 256, edges: 768, operations: 1024,
  proposals: 7, coordinate: 100000, rawChars: 256 * 1024,
});
export const ROLES = Object.freeze([
  'client', 'service', 'datastore', 'queue', 'external', 'module',
  'function', 'class', 'interface', 'event', 'configuration', 'package',
]);
export const ROLE_SHAPES = Object.freeze({
  client: 'browser', service: 'component', datastore: 'cylinder', queue: 'queue',
  external: 'cloud', module: 'rect', function: 'hexagon', class: 'class_box',
  interface: 'interface_box', event: 'document', configuration: 'parallelogram', package: 'folder',
});
export const ROLE_LABELS = Object.freeze({
  client: 'Client', service: 'Service', datastore: 'Datastore', queue: 'Queue',
  external: 'External', module: 'Module', function: 'Function', class: 'Class',
  interface: 'Interface', event: 'Event', configuration: 'Configuration', package: 'Package',
});
export const GENERIC_LABELS = Object.freeze([
  'Component', 'Module', 'Client', 'Service', 'Datastore', 'Queue', 'External',
  'Function', 'Class', 'Interface', 'Event', 'Configuration', 'Package',
]);
export const RELATIONS = Object.freeze(['calls', 'reads', 'writes', 'publishes', 'consumes', 'depends_on']);
export const KINDS = Object.freeze([
  'session.started', 'turn.prompted', 'intent.observed', 'tool.requested',
  'tool.succeeded', 'tool.failed', 'tool.interrupted', 'tool.denied', 'tool.unresolved',
  'batch.completed', 'artifact.changed', 'verification.observed', 'agent.started',
  'agent.stopped', 'turn.stopped', 'session.ended', 'capture.gap',
]);
export const CATEGORIES = Object.freeze(['read', 'write', 'edit', 'shell', 'search', 'test', 'other']);
export const OUTCOMES = Object.freeze(['pending', 'succeeded', 'failed', 'interrupted', 'denied', 'unresolved', 'observed']);
export const SHAPES = Object.freeze([
  'rounded_rect', 'rect', 'cylinder', 'cloud', 'diamond', 'group',
  'hexagon', 'class_box', 'interface_box', 'document', 'parallelogram', 'folder',
  'browser', 'component', 'queue',
]);
export const EVIDENCE_STATES = Object.freeze(['proposed', 'observed', 'verified', 'removed']);
export const ACTIVITY_STATES = Object.freeze(['idle', 'pending', 'running', 'failed', 'interrupted', 'unknown']);
export const CLASSIFICATIONS = Object.freeze(['pending', 'accepted', 'tentative', 'abstained', 'stale']);
export const VALIDITIES = Object.freeze(['current', 'stale', 'retracted']);

export const hash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
export const opaque = (prefix, ...values) => `${prefix}-${hash(values).slice(0, 32)}`;
export const isId = value => typeof value === 'string' && /^(?:[a-z][a-z0-9_]{0,23}-)?[a-f0-9]{24,64}$/.test(value);
export const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const exactKeys = (value, required, optional = []) => plain(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const clone = value => structuredClone(value);
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function fail(code = 'INVALID_CORE_INPUT') {
  // Fixed errors only: no paths, source, transport messages or raw caller fields.
  throw new TypeError(code);
}
