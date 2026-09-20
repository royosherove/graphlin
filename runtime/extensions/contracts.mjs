// Browser-safe API constants and small validators shared by the host and SDK.
export const API_VERSION = 1;
export const MODEL_SCHEMA = 2;
export const SCENE_VERSION = 1;
export const MANIFEST_FILE = 'graphlin.extension.json';
export const FEATURES = Object.freeze([
  'containment', 'canonical-mappings', 'scene-groups', 'activity', 'checkpoints',
]);
export const CAPABILITIES = Object.freeze([
  'model.read', 'activity.read', 'selection.request', 'inspection.request', 'history.read',
  'analysis.request',
]);
export const DATA_FIELDS = Object.freeze([
  'entities', 'relations', 'interpretations', 'activity', 'coverage', 'sessions', 'checkpoints',
]);
export const EXTENSION_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024, assetBytes: 2 * 1024 * 1024, packageBytes: 8 * 1024 * 1024,
  archiveBytes: 12 * 1024 * 1024, assets: 32, files: 128, depth: 8,
  nodes: 256, groups: 64, edges: 768, sceneBytes: 1024 * 1024,
  coordinate: 100_000, dimension: 20_000, members: 256, text: 240,
  projectionBytes: 8 * 1024 * 1024, entities: 20_000, relations: 40_000,
});
export function extensionError(code) {
  return Object.assign(new Error(code), { code });
}
export function check(condition, code = 'invalid_extension') {
  if (!condition) throw extensionError(code);
}
export const plain = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const exact = (value, required, optional = []) => plain(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' &&
    (required.includes(key) || optional.includes(key)) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
export const extensionId = value => typeof value === 'string' &&
  /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/.test(value) && value.length <= 100;
export const version = value => typeof value === 'string' && value.length <= 80 &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(value);
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
export const text = (value, max = EXTENSION_LIMITS.text) => typeof value === 'string' &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value) &&
  !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:javascript|data|file):|url\s*\()/i.test(value);
export const uniqueStrings = (value, predicate, max = 64) => Array.isArray(value) &&
  value.length <= max && value.every(predicate) && new Set(value).size === value.length;
export function assetPath(value) {
  return typeof value === 'string' && value.length <= 200 &&
    value.split('/').length <= EXTENSION_LIMITS.depth &&
    value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part) &&
      !['node_modules', '__proto__', 'constructor', 'prototype'].includes(part));
}
export function jsonBytes(value, limit, code = 'extension_payload_limit') {
  let result;
  try { result = JSON.stringify(value); } catch { throw extensionError(code); }
  check(typeof result === 'string' && new TextEncoder().encode(result).length <= limit, code);
  return result;
}
