import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { safeLabel, safeText, excluded } from '../core/privacy.mjs';

const PREFIX = '/api/model/v1/';
const PAGE_LIMIT = 200, MAX_BYTES = 512 * 1024, PAYLOAD_BYTES = MAX_BYTES - 2048;
const BODY_BYTES = 4096, RETAINED_POSITIONS = 128, MAX_STREAMS = 16, MAX_GRANTS = 32;
const MAX_ENUMERATIONS = 64, ENUMERATION_BYTES = 64 * 1024;
const RECORD_CACHE_BYTES = 16 * 1024 * 1024, RECORD_CACHE_ENTRIES = 75_000;
const CURSOR_TTL = 5 * 60_000, MAX_TTL = 3600;
const COLLECTIONS = ['entities', 'relations', 'interpretations', 'activity', 'sessions', 'checkpoints'];
const FIELDS = [...COLLECTIONS, 'coverage'];
const CAPS = { entities: 20_000, relations: 40_000, interpretations: 4096, activity: 10_000, sessions: 256, checkpoints: 256 };
const COUNT_FIELDS = ['inventoried', 'inspected', 'retained', 'deferred', 'excluded', 'unsupported',
  'unavailable', 'inventoryDeferred', 'oldestSequence', 'observed', 'resolved', 'unresolved',
  'entities', 'relations', 'artifacts', 'imports', 'interpretations', 'scopes', 'files', 'bytes'];
const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) &&
  safeText(value, 160) ? value : undefined;
const text = value => safeLabel(value) && !/[{};`=]/.test(value) ? value : undefined;
const word = value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(value) ? value : undefined;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const API_ERROR = Symbol('model_api_error');
const fault = (status, code) => Object.assign(new Error(code), { status, code, [API_ERROR]: true });
const fail = (status, code) => { throw fault(status, code); };
const integerField = value => natural(value) ? value : undefined;
const positiveInteger = value => natural(value) && value > 0 ? value : undefined;
const booleanField = value => typeof value === 'boolean' ? value : undefined;
const versionField = value => typeof value === 'string' && value.length <= 256 &&
  /^[@A-Za-z0-9][A-Za-z0-9_.@+/-]*$/.test(value) && safeText(value, 256) ? value : undefined;
const time = value => natural(value) ? value : typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const ids = value => Array.isArray(value) && value.length <= 256 && value.every(identifier)
  ? [...new Set(value)] : undefined;
const path = value => typeof value === 'string' && value.length <= 512 && safeText(value, 512) &&
  !/[\\:%<>\r\n]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..') &&
  !excluded(value, {}) ? value : undefined;

const schemaEntries = new WeakMap();
function entries(schema) {
  let result = schemaEntries.get(schema);
  if (!result) { result = Object.entries(schema); schemaEntries.set(schema, result); }
  return result;
}
function pick(value, schema) {
  if (!plain(value)) return undefined;
  const result = {};
  for (const [key, project] of entries(schema)) {
    const input = value[key];
    if (input === undefined) continue;
    const selected = project(input);
    if (selected !== undefined) result[key] = selected;
  }
  return result;
}
const REF_SCHEMA = { artifactId: identifier, eventId: identifier, generation: integerField,
  hash: v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : undefined,
  startLine: integerField, endLine: integerField, sourceClass: word,
  extractor: identifier, extractorVersion: versionField, identityVersion: versionField };
function refs(value) {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const results = [];
  for (const ref of value) {
    const result = pick(ref, REF_SCHEMA);
    if (!result?.artifactId && !result?.eventId) return undefined;
    for (const key of ['artifactId', 'eventId', 'generation', 'hash', 'startLine', 'endLine', 'sourceClass',
      'extractor', 'extractorVersion', 'identityVersion']) {
      if (ref[key] !== undefined && result[key] === undefined) return undefined;
    }
    results.push(result);
  }
  return results;
}
const common = {
  id: identifier, kind: word, label: text, basis: word, validity: word, freshness: word,
  classification: word, support: word, completeness: word, sourceRefs: refs,
  sessionId: identifier, knownAtSequence: integerField,
};
const SCHEMAS = {
  entities: { ...common, parentId: v => v === null ? null : identifier(v), artifactId: identifier,
    qualifiedName: text, relativePath: path, legacyId: identifier, ownership: word, createdAtSequence: positiveInteger },
  relations: { ...common, source: identifier, target: identifier },
  interpretations: { ...common, namespace: identifier, producer: identifier, profile: identifier,
    version: identifier, entityIds: ids },
  activity: { ...common, sequence: integerField, at: time, timestamp: time, recordedAt: time,
    outcome: word, attribution: word, toolCategory: word, agentId: identifier, toolCallId: identifier,
    entityIds: ids, artifactIds: ids, creation: booleanField },
  sessions: { id: identifier, host: word, status: word, startedAt: time, endedAt: time },
  checkpoints: { id: identifier, projectId: identifier, label: text, sessionId: identifier,
    revision: integerField, sequence: integerField, at: time },
};
const SUPPORT_FIELDS = ['sourceRefs', 'entityIds', 'artifactIds'];
const RECORD_FIELDS = Object.fromEntries(Object.entries(SCHEMAS).map(([kind, schema]) =>
  [kind, [...new Set([...Object.keys(schema), ...SUPPORT_FIELDS])]]));
function record(value, kind) {
  const result = pick(value, SCHEMAS[kind]);
  if (!result?.id || (kind === 'relations' && (!result.source || !result.target))) return null;
  // Do not truncate a support/member set while claiming that it is complete.
  for (const field of SUPPORT_FIELDS) {
    if (value[field] !== undefined && result[field] === undefined) return null;
  }
  return bytes(result) <= 64 * 1024 ? result : null;
}
function sameValue(input, projected, schema) {
  if (input === projected) return true;
  if (Array.isArray(projected)) return Array.isArray(input) && input.length === projected.length &&
    projected.every((value, index) => sameValue(input[index], value, schema));
  // Validation reads explicit schema properties, including inherited/non-enumerable
  // ones. Newly present reference fields must invalidate an earlier projection.
  return !!schema && plain(projected) && plain(input) &&
    entries(schema).every(([key]) => input[key] === projected[key]);
}
function enumeration(value) {
  if (!plain(value) || !identifier(value.artifactId) || !identifier(value.scopeId) ||
      !positiveInteger(value.generation) || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash) ||
      !identifier(value.extractor) || !versionField(value.version) || !versionField(value.identityVersion) ||
      typeof value.complete !== 'boolean' || !word(value.capability) ||
      !Array.isArray(value.omissions) || value.omissions.length > 32 || !value.omissions.every(word) ||
      !Array.isArray(value.coveredRanges) || value.coveredRanges.length > 128) return null;
  const coveredRanges = [];
  for (const range of value.coveredRanges) {
    if (!plain(range) || !positiveInteger(range.startLine) || !positiveInteger(range.endLine) ||
        range.startLine > range.endLine || range.endLine > 10_000_000) return null;
    coveredRanges.push({ startLine: range.startLine, endLine: range.endLine });
  }
  return { artifactId: value.artifactId, scopeId: value.scopeId, hash: value.hash, generation: value.generation,
    complete: value.complete && value.capability === 'parsed' && coveredRanges.length > 0 && value.omissions.length === 0 &&
      ![value.extractor, value.version, value.identityVersion].includes('unknown'),
    extractor: value.extractor, version: value.version, identityVersion: value.identityVersion,
    coveredRanges, omissions: [...value.omissions], capability: value.capability };
}
function lineage(value) {
  const result = pick(value, {
    id: identifier,
    status: value => ['git', 'not_git', 'unavailable'].includes(value) ? value : undefined,
    branch: text,
    head: value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value) ? value : undefined,
  });
  return result?.id && result.status ? result : undefined;
}
function coverage(value, selectedArtifacts) {
  const schema = Object.fromEntries(COUNT_FIELDS.map(field => [field, integerField]));
  const result = pick(value, { ...schema, complete: booleanField, truncated: booleanField, lineage }) ?? {};
  for (const name of ['deferred', 'relationships', 'limits']) {
    const projected = pick(value?.[name], schema);
    if (projected) result[name] = projected;
  }
  // Coverage detail is inventory, not a licence to export arbitrary nested data.
  result.detailCounts = Object.fromEntries(['scopes', 'files', 'enumerations', 'artifacts']
    .map(name => [name, Array.isArray(value?.[name]) ? value[name].length : 0]));
  result.parsing = pick(value?.parsing, {
    ...Object.fromEntries(['queued', 'active', 'deferred', 'parsed', 'failed', 'stale', 'omitted']
      .map(field => [field, integerField])),
    lastError: value => value === null ? null : word(value),
  }) ?? {};
  const inputs = (Array.isArray(value?.enumerations) ? value.enumerations : [])
    .filter(value => !selectedArtifacts || selectedArtifacts.has(value?.artifactId));
  const seen = new Set(), duplicates = new Set();
  for (const value of inputs) {
    if (seen.has(value?.artifactId)) duplicates.add(value.artifactId);
    seen.add(value?.artifactId);
  }
  result.enumerations = [];
  let retainedBytes = 2;
  for (const input of inputs) {
    if (duplicates.has(input?.artifactId)) continue;
    const certificate = enumeration(input);
    if (!certificate) continue;
    const length = bytes(certificate) + 1;
    if (result.enumerations.length >= MAX_ENUMERATIONS || retainedBytes + length > ENUMERATION_BYTES) continue;
    result.enumerations.push(certificate); retainedBytes += length;
  }
  result.enumerations.sort((a, b) => compare(a.artifactId, b.artifactId));
  result.enumerationCoverage = { total: inputs.length, returned: result.enumerations.length,
    omitted: inputs.length - result.enumerations.length, truncated: inputs.length > result.enumerations.length };
  if (result.enumerationCoverage.truncated) result.truncated = true;
  return result;
}
function containmentOrder(entities) {
  const byId = new Map(entities.map(value => [value.id, value])), children = new Map(), pending = [];
  // The input is ID-sorted: roots and each sibling group are deterministic.
  for (const entity of entities) {
    if (!entity.parentId || !byId.has(entity.parentId)) pending.push(entity);
    else {
      if (!children.has(entity.parentId)) children.set(entity.parentId, []);
      children.get(entity.parentId).push(entity);
    }
  }
  const ordered = [];
  for (let offset = 0; offset < pending.length; offset++) {
    const entity = pending[offset];
    ordered.push(entity);
    for (const child of children.get(entity.id) ?? []) pending.push(child);
  }
  if (ordered.length !== entities.length) fail(503, 'invalid_model_containment');
  return ordered;
}
function exactKeys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'invalid_input');
}
function origin(value) {
  if (typeof value !== 'string' || value.length > 256 || value.includes('*')) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value &&
      !url.username && !url.password ? value : null;
  } catch { return null; }
}
function strictJSON(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { fail(400, 'invalid_json'); }
  // JSON.parse accepts duplicate keys. Reject those before validating the shape.
  const stack = [];
  for (const match of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    const token = match[0], top = stack.at(-1);
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push({ key: false });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.keys) top.key = true;
    else if (token.startsWith('"') && top?.key) {
      const key = JSON.parse(token);
      if (top.keys.has(key)) fail(400, 'duplicate_key');
      top.keys.add(key); top.key = false;
    }
  }
  if (!plain(value)) fail(400, 'invalid_input');
  return value;
}
function bodyJSON(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') ||
      req.headers['content-encoding']) fail(415, 'invalid_content_type');
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) ||
      Number(req.headers['content-length']) > BODY_BYTES)) fail(413, 'input_too_large');
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    const finish = (error, result) => {
      clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', broken); req.removeListener('aborted', broken);
      chunks = [];
      if (error) { req.resume(); reject(error); } else resolve(result);
    };
    const broken = () => finish(fault(400, 'invalid_input'));
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_BYTES) finish(fault(413, 'input_too_large'));
      else chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, strictJSON(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { finish(error); }
    };
    const timer = setTimeout(() => finish(fault(408, 'request_timeout')), 2000);
    timer.unref?.();
    req.on('data', data); req.on('end', end); req.on('error', broken); req.on('aborted', broken);
  });
}

/**
 * The caller validates loopback and Host BEFORE dispatch and supplies an already
 * authenticated viewer principal. Callbacks must synchronously return snapshots
 * projected through CURRENT disclosure policy, including historical reads.
 */
export function createModelAPI({ projectId, getSnapshot, getSessions, createCheckpoint, now = Date.now } = {}) {
  if (!identifier(projectId) || typeof getSnapshot !== 'function' || typeof now !== 'function' ||
      (getSessions !== undefined && typeof getSessions !== 'function') ||
      (createCheckpoint !== undefined && typeof createCheckpoint !== 'function')) {
    throw new TypeError('invalid_model_api_options');
  }
  let epoch = secret().slice(0, 22), sequence = 1, closed = false, flushTask;
  let retained = [1];
  const cursorKey = randomBytes(32), grants = new Map(), clients = new Set();
  const recordCache = new Map();
  let recordCacheBytes = 0;
  function clearRecordCache() { recordCache.clear(); recordCacheBytes = 0; }
  function projectedRecord(value, kind) {
    const key = typeof value?.id === 'string' ? `${kind}:${value.id}` : null;
    const cached = key && recordCache.get(key);
    // Compare every allowed field with CURRENT provider input, including nested
    // support. Revision alone cannot detect policy redaction or changed evidence.
    if (cached && plain(value) && RECORD_FIELDS[kind].every(field =>
      sameValue(value[field], cached.value[field], field === 'sourceRefs' ? REF_SCHEMA : undefined))) return cached.value;
    if (cached) { recordCache.delete(key); recordCacheBytes -= cached.bytes; }
    const result = record(value, kind);
    if (result) {
      const size = bytes(result);
      if (recordCache.size < RECORD_CACHE_ENTRIES && recordCacheBytes + size <= RECORD_CACHE_BYTES) {
        recordCache.set(key, { value: result, bytes: size }); recordCacheBytes += size;
      }
    }
    return result;
  }
  const viewer = { id: 'viewer', fields: FIELDS, history: true };
  const bounds = () => ({ epoch, oldestSequence: retained[0], latestSequence: sequence });
  const selectionKey = (selection, principal) => digest(JSON.stringify([projectId, selection, principal.id])).slice(0, 24);
  const eventId = (position, key) => `${epoch}:${position}:${key}`;
  function json(res, status, value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_BYTES) fail(503, 'response_too_large');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data);
  }
  function endClient(client, reason) {
    clients.delete(client);
    if (client.res.destroyed || client.res.writableEnded) return;
    if (client.res.writableLength) client.res.destroy();
    else {
      if (reason) client.res.write(`event: ${reason}\ndata: {"reason":"${reason}"}\n\n`);
      client.res.end();
    }
  }
  function removeGrant(hash, reason = 'revoked') {
    const grant = grants.get(hash);
    if (!grant) return;
    grants.delete(hash); clearTimeout(grant.timer); clearRecordCache();
    for (const client of clients) if (client.principal.id === grant.id) endClient(client, reason);
  }
  function sweep() {
    for (const [hash, grant] of grants) if (grant.expiresAt <= now()) removeGrant(hash, 'expired');
  }
  function principalFor(req, viewerAuthorized) {
    sweep();
    for (const name of ['authorization', 'origin']) {
      if ((req.rawHeaders ?? []).filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length > 1) {
        fail(400, 'duplicate_header');
      }
    }
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail(401, 'invalid_token');
      const grant = grants.get(digest(authorization.slice(7)));
      if (!grant || grant.projectId !== projectId) fail(401, 'invalid_token');
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined && (!origin(requestOrigin) || !grant.origins.includes(requestOrigin))) {
        fail(403, 'forbidden_origin');
      }
      return grant;
    }
    if (viewerAuthorized !== true) fail(401, 'authentication_required');
    if (req.headers.origin !== undefined && (!origin(req.headers.origin) ||
        new URL(req.headers.origin).host !== req.headers.host)) fail(403, 'forbidden_origin');
    return viewer;
  }
  function hostMutation(req, principal) {
    if (principal !== viewer) fail(403, 'viewer_required');
    if (!origin(req.headers.origin) || new URL(req.headers.origin).host !== req.headers.host ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      fail(403, 'forbidden_origin');
    }
  }
  function cors(res, requestOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }
  function parameters(url, allowed) {
    const result = {};
    for (const [name, value] of url.searchParams) {
      if (!allowed.includes(name) || Object.hasOwn(result, name) || !value) fail(400, 'invalid_query');
      result[name] = value;
    }
    for (const name of ['session', 'checkpoint', 'scope']) {
      if (result[name] !== undefined && !identifier(result[name])) fail(400, 'invalid_query');
    }
    if (result.limit !== undefined && (!/^[1-9]\d{0,2}$/.test(result.limit) || Number(result.limit) > PAGE_LIMIT)) {
      fail(400, 'invalid_limit');
    }
    if (result.cursor !== undefined && result.cursor.length > 2048) fail(400, 'invalid_cursor');
    return result;
  }
  function selectionFor(params, principal) {
    if (!principal.history && (params.session || params.checkpoint)) fail(403, 'history_not_granted');
    return { ...(params.session ? { sessionId: params.session } : {}),
      ...(params.checkpoint ? { checkpointId: params.checkpoint } : {}),
      ...(params.scope ? { scopeId: params.scope } : {}) };
  }
  function requireField(principal, kind) {
    if (!principal.fields.includes(kind)) fail(403, 'field_not_granted');
  }
  function read(selection, principal) {
    const raw = getSnapshot({ ...selection, persistent: false });
    if (!plain(raw) || raw.then || raw.schemaVersion !== 2 || raw.projectId !== projectId ||
        !natural(raw.revision) || !natural(raw.sequence)) fail(503, 'invalid_model_snapshot');
    const result = { schemaVersion: 2, projectId, revision: raw.revision, sequence: raw.sequence };
    const omitted = {};
    for (const kind of COLLECTIONS) {
      let values = raw[kind];
      if (kind === 'sessions' && values === undefined && getSessions && !selection.checkpointId) values = getSessions();
      if (values === undefined) values = [];
      if (!Array.isArray(values) || values.length > CAPS[kind]) fail(503, 'model_capacity_exceeded');
      const allowed = principal.fields.includes(kind) && (kind !== 'checkpoints' || principal.history);
      result[kind] = allowed ? values.map(value => projectedRecord(value, kind)).filter(Boolean) : [];
      omitted[kind] = allowed ? values.length - result[kind].length : 0;
      const seen = new Set();
      for (const value of result[kind]) {
        if (seen.has(value.id)) fail(503, 'duplicate_model_identity');
        seen.add(value.id);
      }
      result[kind].sort((a, b) => kind === 'activity' || kind === 'checkpoints'
        ? (a.sequence ?? 0) - (b.sequence ?? 0) || compare(a.id, b.id) : compare(a.id, b.id));
    }
    result.entities = containmentOrder(result.entities);
    if (selection.sessionId) {
      for (const kind of ['activity', 'sessions', 'checkpoints']) result[kind] = result[kind].filter(value =>
        (kind === 'sessions' ? value.id : value.sessionId) === selection.sessionId);
    }
    if (selection.scopeId) {
      requireField(principal, 'entities');
      const byId = new Map(result.entities.map(entity => [entity.id, entity])), children = new Map();
      if (!byId.has(selection.scopeId)) fail(404, 'scope_not_found');
      for (const entity of result.entities) {
        if (!children.has(entity.parentId)) children.set(entity.parentId, []);
        children.get(entity.parentId).push(entity.id);
      }
      const selected = new Set(), pending = [selection.scopeId];
      while (pending.length) {
        const next = pending.pop();
        if (selected.has(next)) continue;
        selected.add(next);
        for (const child of children.get(next) ?? []) pending.push(child);
      }
      let parent = byId.get(selection.scopeId)?.parentId;
      while (parent && !selected.has(parent)) { selected.add(parent); parent = byId.get(parent)?.parentId; }
      result.entities = result.entities.filter(value => selected.has(value.id));
      result.relations = result.relations.filter(value => selected.has(value.source) && selected.has(value.target));
      result.interpretations = result.interpretations.filter(value =>
        Array.isArray(value.entityIds) && value.entityIds.every(id => selected.has(id)));
      result.activity = result.activity.filter(value => !value.entityIds?.length || value.entityIds.some(id => selected.has(id)));
    }
    result.coverage = principal.fields.includes('coverage') ? coverage(raw.coverage,
      selection.scopeId ? new Set(result.entities.flatMap(value =>
        [value.artifactId, ...(value.sourceRefs ?? []).map(ref => ref.artifactId)].filter(Boolean))) : undefined) : {};
    result.coverage.projection = { omitted, detail: 'summary' };
    return { data: result, fingerprint: digest(JSON.stringify(result)) };
  }
  function cursorFor(context, kind, offset) {
    const body = Buffer.from(JSON.stringify({ e: epoch, p: context.principal.id, k: kind,
      q: context.selection, r: context.data.revision, s: context.data.sequence,
      f: context.fingerprint, o: offset, x: now() + CURSOR_TTL })).toString('base64url');
    return `${body}.${createHmac('sha256', cursorKey).update(body).digest('base64url')}`;
  }
  function offsetFor(cursor, context, kind) {
    if (!cursor) return 0;
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) fail(400, 'invalid_cursor');
    const [body, signature] = cursor.split('.');
    const expected = createHmac('sha256', cursorKey).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'base64url'))) fail(400, 'invalid_cursor');
    let value;
    try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail(400, 'invalid_cursor'); }
    if (value.p !== context.principal.id || value.k !== kind ||
        JSON.stringify(value.q) !== JSON.stringify(context.selection) || !natural(value.o)) fail(400, 'invalid_cursor');
    if (value.e !== epoch || value.r !== context.data.revision || value.s !== context.data.sequence ||
        value.f !== context.fingerprint || value.x <= now()) fail(409, 'stale_cursor');
    return value.o;
  }
  function metadata(context) {
    return { schemaVersion: 2, projectId, revision: context.data.revision, sequence: context.data.sequence,
      selection: context.selection, transport: { ...bounds(), sequence: context.position,
        eventId: eventId(context.position, selectionKey(context.selection, context.principal)) } };
  }
  function page(context, kind, values, params, cursorKind = kind) {
    const offset = offsetFor(params.cursor, context, cursorKind), limit = Number(params.limit ?? PAGE_LIMIT);
    if (offset > values.length) fail(400, 'invalid_cursor');
    const items = [];
    const response = () => ({ ...metadata(context), kind, items, page: { total: values.length, offset,
      returned: items.length, complete: offset + items.length === values.length,
      nextCursor: offset + items.length < values.length ? cursorFor(context, cursorKind, offset + items.length) : null } });
    // Count record bytes once. Repeatedly serializing a large candidate page to
    // remove one record at a time needlessly stalls otherwise bounded reads.
    let size = bytes(response()) + 1024;
    for (const value of values.slice(offset, offset + limit)) {
      const length = bytes(value) + 1;
      if (size + length > PAYLOAD_BYTES) break;
      items.push(value); size += length;
    }
    let result = response();
    while (bytes(result) > PAYLOAD_BYTES && items.length) { items.pop(); result = response(); }
    if (values.length > offset && !items.length) fail(503, 'record_too_large');
    return result;
  }
  function snapshot(context, limit = PAGE_LIMIT) {
    const projectedCoverage = { ...context.data.coverage };
    const certificates = (projectedCoverage.enumerations ?? []).slice(0, Math.floor(limit / 2));
    if (projectedCoverage.enumerations) {
      projectedCoverage.enumerations = certificates;
      const total = projectedCoverage.enumerationCoverage.total;
      projectedCoverage.enumerationCoverage = { total, returned: certificates.length,
        omitted: total - certificates.length, truncated: total > certificates.length };
      if (projectedCoverage.enumerationCoverage.truncated) projectedCoverage.truncated = true;
    }
    const result = { ...metadata(context), coverage: projectedCoverage, pages: {} };
    const counts = Object.fromEntries(COLLECTIONS.map(kind => [kind, 0]));
    // Reserve space for activity and history even when the entity inventory is large.
    for (let remaining = limit - certificates.length; remaining > 0;) {
      let added = false;
      for (const kind of COLLECTIONS) if (remaining && counts[kind] < context.data[kind].length) {
        counts[kind]++; remaining--; added = true;
      }
      if (!added) break;
    }
    const assemble = () => {
      for (const kind of COLLECTIONS) {
        result[kind] = context.data[kind].slice(0, counts[kind]);
        result.pages[kind] = { total: context.data[kind].length, returned: counts[kind],
          nextCursor: counts[kind] < context.data[kind].length ? cursorFor(context, kind, counts[kind]) : null };
      }
      result.partial = COLLECTIONS.some(kind => counts[kind] < context.data[kind].length);
    };
    assemble();
    const sizes = Object.fromEntries(COLLECTIONS.map(kind => [kind, result[kind].map(value => bytes(value) + 1)]));
    const totals = Object.fromEntries(COLLECTIONS.map(kind => [kind, sizes[kind].reduce((sum, size) => sum + size, 0)]));
    const envelope = bytes({ ...result, ...Object.fromEntries(COLLECTIONS.map(kind => [kind, []])) }) + 1024;
    let total = envelope + Object.values(totals).reduce((sum, size) => sum + size, 0);
    while (total > PAYLOAD_BYTES) {
      const kind = COLLECTIONS.filter(kind => counts[kind]).sort((a, b) => totals[b] - totals[a])[0];
      if (!kind) fail(503, 'response_too_large');
      const removed = sizes[kind][--counts[kind]];
      total -= removed; totals[kind] -= removed;
    }
    assemble();
    if (bytes(result) > PAYLOAD_BYTES) fail(503, 'response_too_large');
    return result;
  }
  function capabilities(principal) {
    return { apiVersion: 1, modelSchemaVersion: 2, projectId, fields: principal.fields,
      history: principal.history, checkpointCreation: principal === viewer && !!createCheckpoint,
      grantCreation: principal === viewer, stream: 'scoped-snapshot', resume: 'coalesced-snapshot',
      limits: { pageRecords: PAGE_LIMIT, payloadBytes: MAX_BYTES, retainedPositions: RETAINED_POSITIONS,
        cursorTtlSeconds: CURSOR_TTL / 1000, maxGrantTtlSeconds: MAX_TTL,
        enumerationRecords: MAX_ENUMERATIONS, enumerationBytes: ENUMERATION_BYTES }, ...bounds() };
  }
  function contextFor(selection, principal) {
    const position = sequence; // Capture before callback: reentrant notify is delivered subsequently.
    const result = read(selection, principal);
    if (principal !== viewer && principal.expiresAt <= now()) { sweep(); fail(401, 'invalid_token'); }
    return { ...result, selection, principal, position };
  }
  function writeEvent(client, type, data, id) {
    if (!clients.has(client) || client.res.destroyed || client.res.writableEnded) return;
    if (client.principal !== viewer && client.principal.expiresAt <= now()) { sweep(); return; }
    const frame = `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (Buffer.byteLength(frame) + client.res.writableLength > MAX_BYTES) {
      clients.delete(client); client.res.destroy(); return;
    }
    client.res.write(frame);
  }
  function flush() {
    flushTask = undefined;
    if (closed) return;
    sweep();
    const contexts = new Map();
    for (const client of clients) if (client.position < sequence) {
      try {
        const key = selectionKey(client.selection, client.principal);
        let context = contexts.get(key);
        if (!context) { context = contextFor(client.selection, client.principal); contexts.set(key, context); }
        const result = snapshot(context, client.limit);
        writeEvent(client, 'snapshot', result, result.transport.eventId);
        client.position = context.position;
      } catch { endClient(client, 'unavailable'); }
    }
  }
  function notify() {
    if (closed) return;
    clearRecordCache();
    if (sequence === Number.MAX_SAFE_INTEGER) {
      epoch = secret().slice(0, 22); sequence = 0; retained = [];
      for (const client of clients) endClient(client, 'reset');
    }
    retained.push(++sequence);
    if (retained.length > RETAINED_POSITIONS) retained.shift();
    if (!flushTask) flushTask = setImmediate(flush);
  }
  function stream(req, res, selection, principal, params) {
    if (clients.size >= MAX_STREAMS) fail(503, 'stream_limit');
    const last = req.headers['last-event-id'];
    if (last !== undefined && (typeof last !== 'string' || last.length > 256 || /[\r\n\0]/.test(last))) {
      fail(400, 'invalid_event_id');
    }
    const key = selectionKey(selection, principal);
    let resume, reset;
    if (last) {
      const parsed = /^([A-Za-z0-9_-]{22}):([1-9]\d{0,15}):([a-f0-9]{24})$/.exec(last);
      const position = parsed ? Number(parsed[2]) : NaN;
      if (!principal.history) reset = 'history_not_granted';
      else if (!parsed || parsed[1] !== epoch || parsed[3] !== key) reset = 'wrong_lineage';
      else if (!retained.includes(position)) reset = 'position_unavailable';
      else resume = { fromSequence: position, coalesced: true };
    }
    // Register before obtaining the initial snapshot, without any await in between.
    const client = { req, res, principal, selection, limit: Number(params.limit ?? PAGE_LIMIT), position: 0 };
    clients.add(client);
    res.on('close', () => clients.delete(client));
    let initial, result;
    try { initial = contextFor(selection, principal); result = snapshot(initial, client.limit); }
    catch (error) { clients.delete(client); throw error; }
    if (resume) result.transport.resume = resume;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    if (reset) writeEvent(client, 'reset', { reason: reset, ...bounds() });
    writeEvent(client, 'snapshot', result, result.transport.eventId);
    client.position = initial.position;
  }
  async function handle(req, res, { viewerAuthorized = false } = {}) {
    if (typeof req.url !== 'string' || !req.url.startsWith(PREFIX)) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (closed) fail(503, 'model_api_closed');
      if (req.url.length > 4096 || /[\s\\#]/.test(req.url) || /%(?![a-f\d]{2})/i.test(req.url) ||
          req.url.split('?')[0].split('/').some(part => part === '.' || part === '..')) fail(400, 'invalid_route');
      const url = new URL(req.url, 'http://model.invalid');
      if (!url.pathname.startsWith(PREFIX) || url.pathname.includes('%') || url.pathname.includes('//')) fail(400, 'invalid_route');
      const route = url.pathname.slice(PREFIX.length);
      const entityRoute = /^entities\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})(\/children)?$/.exec(route);
      const readRoutes = ['capabilities', 'bootstrap', 'snapshot', 'events', 'history',
        'entities', 'relations', 'interpretations', 'activity', 'sessions'];
      const readable = readRoutes.includes(route) || !!entityRoute;
      const allowed = route === 'capabilities' ? [] : ['scope', 'session', 'checkpoint',
        ...(!(entityRoute && !entityRoute[2]) ? ['limit'] : []),
        ...(route === 'history' ? ['kind'] : []),
        ...(!['events', 'bootstrap', 'snapshot'].includes(route) && !(entityRoute && !entityRoute[2]) ? ['cursor'] : [])];
      if (req.method === 'OPTIONS') {
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) fail(400, 'unexpected_body');
        parameters(url, allowed);
        if (!readable || req.headers['access-control-request-method'] !== 'GET' || !origin(req.headers.origin)) fail(403, 'forbidden_origin');
        const requested = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
        if (requested.some(name => !['authorization', 'last-event-id'].includes(name))) fail(403, 'forbidden_headers');
        sweep();
        if (![...grants.values()].some(grant => grant.origins.includes(req.headers.origin))) fail(403, 'forbidden_origin');
        cors(res, req.headers.origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Last-Event-ID');
        res.writeHead(204); res.end(); return true;
      }
      const principal = principalFor(req, viewerAuthorized);
      if (principal !== viewer && req.method !== 'GET') fail(403, 'viewer_required');
      if (req.method === 'GET' && readable) {
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) fail(400, 'unexpected_body');
        const params = parameters(url, allowed), selection = selectionFor(params, principal);
        if (principal !== viewer && req.headers.origin) cors(res, req.headers.origin);
        if (route === 'capabilities') { json(res, 200, capabilities(principal)); return true; }
        if (route === 'history' && !principal.history) fail(403, 'history_not_granted');
        if (route === 'events') { stream(req, res, selection, principal, params); return true; }
        const context = contextFor(selection, principal);
        let result;
        if (route === 'snapshot' || route === 'bootstrap') {
          result = snapshot(context, Number(params.limit ?? PAGE_LIMIT));
          if (route === 'bootstrap') result.capabilities = capabilities(principal);
        } else if (entityRoute) {
          requireField(principal, 'entities');
          const id = entityRoute[1], entity = context.data.entities.find(value => value.id === id);
          if (!entity) fail(404, 'entity_not_found');
          result = entityRoute[2] ? page(context, 'entities',
            context.data.entities.filter(value => value.parentId === id), params, `children:${id}`)
            : { ...metadata(context), entity };
        } else {
          const kind = route === 'history' ? params.kind ?? 'checkpoints' : route;
          if (route === 'history' && !['checkpoints', 'activity'].includes(kind)) fail(400, 'invalid_query');
          requireField(principal, kind);
          result = page(context, kind, context.data[kind], params);
        }
        json(res, 200, result); return true;
      }
      if (req.method !== 'POST' || !['grants', 'grants/revoke', 'checkpoints'].includes(route)) fail(404, 'not_found');
      parameters(url, []); hostMutation(req, principal);
      const input = await bodyJSON(req);
      if (closed) fail(503, 'model_api_closed');
      if (route === 'grants') {
        exactKeys(input, ['projectId', 'fields', 'history', 'ttlSeconds', 'origins']);
        if (input.projectId !== projectId) fail(403, 'wrong_project');
        if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > FIELDS.length ||
            input.fields.some(field => !FIELDS.includes(field)) || new Set(input.fields).size !== input.fields.length ||
            typeof input.history !== 'boolean') fail(400, 'invalid_grant');
        const ttl = input.ttlSeconds ?? 900, origins = input.origins ?? [];
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL || !Array.isArray(origins) || origins.length > 8 ||
            origins.some(value => !origin(value)) || new Set(origins).size !== origins.length) fail(400, 'invalid_grant');
        sweep();
        if (grants.size >= MAX_GRANTS) fail(429, 'grant_limit');
        const token = secret(), hash = digest(token);
        const grant = { id: `grant-${secret().slice(0, 22)}`, projectId, fields: [...input.fields].sort(),
          history: input.history, origins: [...origins], expiresAt: now() + ttl * 1000 };
        grant.timer = setTimeout(() => removeGrant(hash, 'expired'), ttl * 1000); grant.timer.unref?.();
        grants.set(hash, grant);
        json(res, 201, { grant: { id: grant.id, projectId, fields: grant.fields, history: grant.history,
          origins: grant.origins, expiresAt: grant.expiresAt }, token });
      } else if (route === 'grants/revoke') {
        exactKeys(input, ['grantId']);
        if (!identifier(input.grantId)) fail(400, 'invalid_input');
        for (const [hash, grant] of grants) if (grant.id === input.grantId) removeGrant(hash);
        json(res, 200, { revoked: true });
      } else {
        exactKeys(input, ['label', 'sessionId']);
        if ((input.label !== undefined && !text(input.label)) ||
            (input.sessionId !== undefined && !identifier(input.sessionId))) fail(400, 'invalid_input');
        if (!createCheckpoint) fail(501, 'checkpoints_unavailable');
        const marker = record(createCheckpoint(input), 'checkpoints');
        if (!marker || marker.projectId !== projectId || !natural(marker.revision) || !natural(marker.sequence)) {
          fail(503, 'invalid_checkpoint');
        }
        notify(); json(res, 201, { checkpoint: marker });
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {
        const known = { MODEL_CHECKPOINT_UNAVAILABLE: [404, 'checkpoint_unavailable'],
          MODEL_CHECKPOINT_CAPACITY: [409, 'checkpoint_capacity'] }[error?.code];
        const status = known?.[0] ?? (error?.[API_ERROR] ? error.status : 503);
        if ([408, 413].includes(status)) res.setHeader('Connection', 'close');
        json(res, status, { error: known?.[1] ?? (error?.[API_ERROR] ? error.code : 'model_unavailable') });
      }
    }
    return true;
  }
  // Expiry is enforced even on an idle stream and with an injected clock.
  const timer = setInterval(sweep, 250); timer.unref?.();
  function close() {
    if (closed) return;
    closed = true; clearInterval(timer); clearImmediate(flushTask);
    clearRecordCache();
    for (const client of clients) endClient(client, 'closed');
    for (const grant of grants.values()) clearTimeout(grant.timer);
    grants.clear(); retained = []; cursorKey.fill(0);
  }
  return { handle, notify, close };
}
