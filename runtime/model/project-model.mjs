import path from 'node:path';
import { integer, plain } from '../core/common.mjs';
import {
  DEFAULT_LIMITS, id, token, label, key, byteSize, relativePath, currentPolicy,
  references, classification, entityRecord, relationRecord, interpretationRecord, certificate,
  activityRecord, lineageRecord, projectSnapshot, time,
} from './records.mjs';
import { compareCheckpoint } from './changes.mjs';
import { restoreFrozenSnapshot } from './history.mjs';

const sameVersion = (a, b) => a?.hash === b?.hash && a?.generation === b?.generation;
const copy = value => structuredClone(value);
const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const sourceRef = (cert, item, event) => ({
  artifactId: cert.artifactId, hash: cert.hash, generation: cert.generation,
  extractor: cert.extractor, extractorVersion: cert.version, identityVersion: cert.identityVersion,
  ...(integer(item?.startLine, 1) && integer(item?.endLine, item.startLine)
    ? { startLine: item.startLine, endLine: item.endLine } : {}),
  ...(id(event?.id) ? { eventId: event.id } : {}),
});

/**
 * Project facts belong to the worktree. Sessions only filter activity.
 * No renderer state, source text, filesystem access, or asynchronous work lives here.
 * @param {{projectId:string, policy?:object|Function, restoredState?:object,
 *   limits?:object, now?:Function|number}} options
 */
export function createProjectModel({ projectId, policy = {}, restoredState, limits = {}, now = Date.now } = {}) {
  if (!id(projectId)) fail('INVALID_MODEL_PROJECT');
  limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, maximum]) =>
    [name, integer(limits?.[name], 1) ? Math.min(limits[name], maximum) : maximum]));
  const clock = () => typeof now === 'function' ? now() : now;
  const entities = new Map(), relations = new Map(), interpretations = new Map();
  const artifacts = new Map(), files = new Map(), scopes = new Map(), imports = new Map();
  const activities = new Map(), sessions = new Map(), checkpoints = new Map();
  const dependents = new Map(), children = new Map(), incident = new Map(), memberships = new Map(), symbols = new Set();
  const importTargets = new Map(), pendingImports = new Set();
  const weights = new WeakMap();
  let bytes = 0, historyBytes = 0, revision = 0, sequence = 0;
  let lineage = null;
  const deferred = { entities: 0, relations: 0, artifacts: 0, imports: 0, interpretations: 0, scopes: 0 };
  let inventoryCoverage = { complete: false, inventoried: 0, deferred: 0, excluded: 0, unsupported: 0, unavailable: 0 };
  const rootId = key('project', projectId);

  function unlink(index, indexKey, value) {
    const set = index.get(indexKey);
    set?.delete(value);
    if (set?.size === 0) index.delete(indexKey);
  }
  function link(index, indexKey, value) {
    if (!indexKey) return;
    if (!index.has(indexKey)) index.set(indexKey, new Set());
    index.get(indexKey).add(value);
  }
  function unindex(record, type) {
    for (const ref of record.sourceRefs ?? []) unlink(dependents, ref.artifactId, record);
    if (type === 'entities') {
      unlink(children, record.parentId, record.id);
      symbols.delete(record.id);
    } else if (type === 'relations') {
      unlink(incident, record.source, record.id);
      unlink(incident, record.target, record.id);
    } else if (type === 'interpretations') {
      for (const entityId of record.entityIds) unlink(memberships, entityId, record.id);
    } else if (type === 'imports') {
      for (const target of record.candidates) unlink(importTargets, target, record.id);
      pendingImports.delete(record.id);
    }
  }
  function index(record, type) {
    for (const ref of record.sourceRefs ?? []) link(dependents, ref.artifactId, record);
    if (type === 'entities') {
      link(children, record.parentId, record.id);
      if (!['project', 'directory', 'file', 'module'].includes(record.kind)) symbols.add(record.id);
    } else if (type === 'relations') {
      link(incident, record.source, record.id);
      link(incident, record.target, record.id);
    } else if (type === 'interpretations') {
      for (const entityId of record.entityIds) link(memberships, entityId, record.id);
    } else if (type === 'imports') {
      for (const target of record.candidates) link(importTargets, target, record.id);
      pendingImports.add(record.id);
    }
  }
  function remove(map, recordId, type) {
    const old = map.get(recordId);
    if (!old) return;
    bytes -= weights.get(old) ?? 0;
    map.delete(recordId);
    if (type) unindex(old, type);
  }
  function put(map, recordId, record, cap, type) {
    const old = map.get(recordId), weight = byteSize(record);
    const delta = weight - (old ? weights.get(old) ?? 0 : 0);
    if ((!old && map.size >= cap) || bytes + historyBytes + delta > limits.bytes) {
      // A byte limit must never preserve a now-invalid current relationship.
      // Eviction is reported as coverage loss, never as source deletion.
      if (old && ['relations', 'imports'].includes(type) && record.validity !== 'current') {
        remove(map, recordId, type);
        deferred[type]++;
      }
      return false;
    }
    if (old && type) unindex(old, type);
    bytes += delta;
    map.set(recordId, record);
    weights.set(record, weight);
    if (type) index(record, type);
    return true;
  }
  function detachChildren(parentId) {
    for (const childId of [...(children.get(parentId) ?? [])]) {
      const child = entities.get(childId);
      if (!child) continue;
      const detached = { ...child, parentId: null, ownership: 'unresolved' };
      if (!put(entities, childId, detached, limits.entities, 'entities')) {
        // Drop optional display metadata before allowing a dangling parent.
        delete detached.qualifiedName;
        delete detached.knownAtSequence;
        put(entities, childId, detached, limits.entities, 'entities');
      }
    }
  }
  function evictEntity(entityId, defer = true) {
    const entity = entities.get(entityId), artifact = artifacts.get(entity?.artifactId);
    detachChildren(entityId);
    for (const relationId of [...(incident.get(entityId) ?? [])]) remove(relations, relationId, 'relations');
    for (const interpretationId of [...(memberships.get(entityId) ?? [])]) remove(interpretations, interpretationId, 'interpretations');
    remove(entities, entityId, 'entities');
    if (['parsed', 'lexical'].includes(entity?.basis) && artifact?.enumeration?.complete) {
      // Release the entity's bytes first, so this correctness update also fits
      // when eviction was triggered by the serialized-byte limit.
      put(artifacts, artifact.id, { ...artifact, enumeration: {
        ...artifact.enumeration, complete: false, omissions: ['model_capacity'],
      } }, limits.artifacts);
    }
    if (defer) deferred.entities++;
  }
  function admitEntity(entity, summary = false) {
    // File and root summaries can replace expanded symbols, including when
    // discovered after a tooling-heavy batch has filled the model.
    while (summary && (!entities.has(entity.id) && entities.size >= limits.entities ||
      bytes + historyBytes + byteSize(entity) > limits.bytes) && symbols.size) {
      evictEntity(symbols.values().next().value);
    }
    const accepted = put(entities, entity.id, entity, limits.entities, 'entities');
    if (!accepted) deferred.entities++;
    return accepted;
  }
  function admitRelation(relation) {
    if (!entities.has(relation.source) || !entities.has(relation.target)) return false;
    const accepted = put(relations, relation.id, relation, limits.relations, 'relations');
    if (!accepted) deferred.relations++;
    return accepted;
  }
  function appendActivity(event, nextSequence = sequence) {
    const record = activityRecord(event, nextSequence, clock());
    if (!record) return;
    const storageId = `${nextSequence}`;
    while (activities.size >= limits.activity) remove(activities, activities.keys().next().value);
    put(activities, storageId, record, limits.activity);
  }
  function commit(kind, event = {}) {
    revision++;
    sequence++;
    appendActivity({ ...event, kind, outcome: 'observed' });
  }
  function metadataEntity(recordId, displayPath, kind, parentId) {
    return {
      id: recordId, label: displayPath ? displayPath.split('/').at(-1) : 'Project',
      kind, parentId, sourceRefs: [], basis: 'metadata', validity: 'current', classification: 'unknown',
      knownAtSequence: sequence + 1, ...(displayPath ? { relativePath: displayPath } : {}),
    };
  }
  admitEntity(metadataEntity(rootId, null, 'project', null), true);

  function ensureDirectory(directory) {
    if (!directory || directory === '.') return rootId;
    let parentId = rootId, accumulated = '';
    for (const part of directory.split('/').slice(0, 32)) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const scopeId = key('scope', projectId, accumulated);
      if (!scopes.has(scopeId)) {
        if (scopes.size >= limits.scopes && parentId === rootId) {
          const nested = [...scopes.values()].find(scope => scope.relativePath.includes('/'));
          if (nested) {
            evictEntity(nested.id, false);
            remove(scopes, nested.id);
            deferred.scopes++;
          }
        }
        if (scopes.size >= limits.scopes) { deferred.scopes++; return parentId; }
        const record = { id: scopeId, parentId, relativePath: accumulated, label: accumulated, inventoried: 0, deferred: 0 };
        if (!admitEntity(metadataEntity(scopeId, accumulated, 'directory', parentId), true) ||
            !put(scopes, scopeId, record, limits.scopes)) return parentId;
      }
      parentId = scopeId;
    }
    return parentId;
  }

  function observeInventory({ entries = [], coverage = {} } = {}) {
    if (!Array.isArray(entries)) return stats();
    const effectivePolicy = currentPolicy(policy);
    const accepted = [];
    for (const entry of entries.slice(0, limits.artifacts * 2)) {
      if (!plain(entry)) continue;
      const name = relativePath(entry.relativePath, effectivePolicy);
      if (!name) continue;
      const suppliedRoot = relativePath(entry.root, effectivePolicy);
      const root = suppliedRoot && (entry.kind === 'directory' && name === suppliedRoot || name.startsWith(`${suppliedRoot}/`))
        ? suppliedRoot : name.includes('/') ? name.split('/')[0] : '';
      // Reserve known roots before spending the remaining budget on files.
      if (root) ensureDirectory(root);
      accepted.push({ entry, name, root });
    }
    for (const { entry, name, root } of accepted) {
      const directory = entry.kind === 'directory';
      const parentId = ensureDirectory(directory ? name : path.posix.dirname(name));
      if (directory) continue;
      const old = files.get(name);
      if (!old && files.size >= limits.artifacts) {
        deferred.artifacts++;
        const scope = scopes.get(parentId);
        if (scope) put(scopes, parentId, { ...scope, deferred: scope.deferred + 1 }, limits.scopes);
        continue;
      }
      const scopeId = id(entry.scopeId) ?? old?.scopeId ?? key('file', projectId, name);
      const record = {
        id: key('inventory', projectId, name), relativePath: name, root, kind: token(entry.kind, 'file'),
        size: integer(entry.size) ? entry.size : 0,
        mtimeMs: Number.isFinite(entry.mtimeMs) && entry.mtimeMs >= 0 ? entry.mtimeMs : 0,
        scopeId, parentId,
        ...(id(entry.artifactId) || old?.artifactId ? { artifactId: id(entry.artifactId) ?? old.artifactId } : {}),
      };
      if (!put(files, name, record, limits.artifacts)) { deferred.artifacts++; continue; }
      scheduleImports(name);
      if (!entities.has(scopeId)) admitEntity(metadataEntity(scopeId, name, 'file', parentId), true);
      if (!old) {
        const scope = scopes.get(parentId);
        if (scope) put(scopes, parentId, { ...scope, inventoried: scope.inventoried + 1 }, limits.scopes);
      }
    }
    inventoryCoverage = {
      complete: coverage.complete === true && deferred.artifacts === 0 && deferred.scopes === 0,
      ...Object.fromEntries(['inventoried', 'deferred', 'excluded', 'unsupported', 'unavailable'].map(field =>
        [field, integer(coverage[field]) ? coverage[field] : field === 'inventoried' ? files.size : 0])),
    };
    commit('inventory.observed');
    resolveImports();
    return stats();
  }

  function artifactDependents(artifactId, freshness) {
    for (const record of [...(dependents.get(artifactId) ?? [])]) {
      const type = Object.hasOwn(record, 'parentId') ? 'entities'
        : Object.hasOwn(record, 'source') ? 'relations' : Object.hasOwn(record, 'specifier') ? 'imports' : 'interpretations';
      const map = { entities, relations, interpretations, imports }[type];
      const current = map.get(record.id);
      if (!current) continue;
      const updated = { ...current, validity: freshness };
      if ('classification' in record) updated.classification = freshness === 'current' ? record.classification : 'stale';
      put(map, record.id, updated, limits[type], type);
      if (type === 'entities') invalidateEntitySupport(record.id, freshness);
    }
  }
  function invalidateEntitySupport(entityId, freshness) {
    for (const interpretationId of [...(memberships.get(entityId) ?? [])]) {
      const record = interpretations.get(interpretationId);
      if (record) put(interpretations, record.id, { ...record, validity: 'stale', classification: 'stale' }, limits.interpretations, 'interpretations');
    }
    for (const relationId of [...(incident.get(entityId) ?? [])]) {
      const record = relations.get(relationId);
      if (record) put(relations, record.id, { ...record, validity: freshness }, limits.relations, 'relations');
    }
    if (freshness === 'retracted') detachChildren(entityId);
  }

  function invalidateArtifacts(values = []) {
    if (!Array.isArray(values)) return stats();
    for (const input of values.slice(0, limits.artifacts)) {
      const value = typeof input === 'string' ? { id: input } : input;
      const artifactId = id(value?.id ?? value?.artifactId);
      if (!artifactId) continue;
      const old = artifacts.get(artifactId);
      const generation = integer(value.generation, 1) ? value.generation : old?.generation ?? 1;
      if (old && generation < old.generation) continue;
      const hash = typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash) ? value.hash : null;
      if (old && generation === old.generation && old.hash && hash && old.hash !== hash) continue;
      const status = ['present', 'partial', 'missing', 'unavailable'].includes(value.status) ? value.status : 'unavailable';
      const name = relativePath(value.relativePath, currentPolicy(policy)) ?? old?.relativePath;
      const record = {
        id: artifactId, hash, generation, status,
        fresh: status === 'present' && sameVersion(old, { hash, generation }) && old?.fresh === true,
        observed: status === 'present' && hash !== null,
        complete: value.complete === true,
        ...(name ? { relativePath: name } : {}),
        ...(old?.enumeration ? { enumeration: old.enumeration } : {}),
      };
      if (!put(artifacts, artifactId, record, limits.artifacts)) { deferred.artifacts++; continue; }
      if (name && files.has(name)) put(files, name, { ...files.get(name), artifactId }, limits.artifacts);
      if (status !== 'present' || !sameVersion(old, record)) {
        artifactDependents(artifactId, status === 'missing' && value.complete === true ? 'retracted' : 'stale');
      }
    }
    commit('artifacts.observed');
    return stats();
  }

  function currentRefs(refs) {
    return refs.length > 0 && refs.every(ref => {
      const artifact = artifacts.get(ref.artifactId);
      return ref.sourceClass !== 'public_intent' && artifact?.status === 'present' && sameVersion(artifact, ref) &&
        artifact.fresh === true;
    });
  }
  function validParent(entity, parentId) {
    const parent = entities.get(parentId);
    if (!parent || parent.validity === 'retracted' || parent.id === entity.id ||
        parent.artifactId !== entity.artifactId) return false;
    const childSpan = entity.sourceRefs[0], parentSpan = parent.sourceRefs[0];
    if (!childSpan?.startLine || !parentSpan?.startLine ||
        parentSpan.startLine > childSpan.startLine || parentSpan.endLine < childSpan.endLine) return false;
    const seen = new Set([entity.id]);
    let next = parent;
    while (next) {
      if (seen.has(next.id) || seen.size > 256) return false;
      seen.add(next.id);
      next = entities.get(next.parentId);
    }
    return true;
  }

  function observeStructure(structure, { event } = {}) {
    const cert = certificate(structure?.enumeration);
    if (!currentPolicy(policy).readSource || !cert || !Array.isArray(structure.entities) ||
        event?.kind === 'tool.requested' || event?.sourceClass === 'public_intent') return stats();
    const oldArtifact = artifacts.get(cert.artifactId);
    if (oldArtifact && (cert.generation < oldArtifact.generation ||
      cert.generation === oldArtifact.generation && (oldArtifact.hash && oldArtifact.hash !== cert.hash ||
        ['missing', 'unavailable'].includes(oldArtifact.status)))) return stats();
    const root = structure.entities.find(entity => entity?.id === cert.scopeId);
    if (!root || root.parentId != null || root.artifactId !== cert.artifactId) return stats();
    let name = relativePath(structure.relativePath, currentPolicy(policy)) ?? oldArtifact?.relativePath;
    if (!name && files.has(root.qualifiedName)) name = root.qualifiedName;
    if (!name) {
      for (const file of files.values()) {
        if (file.artifactId === cert.artifactId || file.scopeId === cert.scopeId || file.relativePath === root.label) {
          name = file.relativePath; break;
        }
      }
    }
    const file = name ? files.get(name) : null;
    if (name && /\.(?:md|markdown|mdx|rst|adoc|txt)$/i.test(name)) return stats();
    const previous = new Set([...dependents.get(cert.artifactId) ?? []].filter(record =>
      entities.get(record.id) === record && record.artifactId === cert.artifactId).map(record => record.id));
    const artifact = {
      id: cert.artifactId, hash: cert.hash, generation: cert.generation, status: 'present',
      complete: cert.complete, fresh: true, enumeration: cert, ...(name ? { relativePath: name } : {}),
    };
    if (!put(artifacts, artifact.id, artifact, limits.artifacts)) { deferred.artifacts++; return stats(); }
    if (oldArtifact && !sameVersion(oldArtifact, cert)) artifactDependents(cert.artifactId, 'stale');
    if (file) {
      if (file.scopeId !== cert.scopeId && entities.get(file.scopeId)?.basis === 'metadata') evictEntity(file.scopeId, false);
      put(files, name, { ...file, artifactId: cert.artifactId, scopeId: cert.scopeId }, limits.artifacts);
    }
    const incoming = new Map(), desiredParents = new Map();
    let complete = cert.complete && structure.entities.length <= limits.entities * 2;
    for (const value of structure.entities.slice(0, limits.entities * 2)) {
      if (!plain(value) || value.artifactId !== cert.artifactId || !id(value.id) || incoming.has(value.id)) {
        complete = false; continue;
      }
      const existing = entities.get(value.id);
      if (existing && existing.artifactId && existing.artifactId !== cert.artifactId) { complete = false; continue; }
      const entity = entityRecord({
        ...value, parentId: null, basis: cert.capability === 'parsed' ? 'parsed' : 'lexical',
        validity: 'current', classification: cert.capability === 'parsed' ? 'accepted' : 'tentative',
        sourceRefs: [sourceRef(cert, value, event)], knownAtSequence: existing?.knownAtSequence ?? sequence + 1,
        createdAtSequence: existing?.createdAtSequence,
        ...(value.id === cert.scopeId && name ? { relativePath: name } : {}),
      }, limits.refs);
      if (!entity) { complete = false; continue; }
      incoming.set(entity.id, entity);
      desiredParents.set(entity.id, id(value.parentId));
    }
    // Root admission precedes symbol admission even if a parser returns it last.
    const rootEntity = incoming.get(cert.scopeId);
    if (!rootEntity || !admitEntity({
      ...rootEntity, parentId: entities.has(file?.parentId) ? file.parentId : null,
    }, true)) return stats();
    for (const entity of incoming.values()) {
      if (entity.id !== cert.scopeId && !admitEntity(entity)) complete = false;
    }
    for (const [entityId, parentId] of desiredParents) {
      if (entityId === cert.scopeId) continue;
      const entity = entities.get(entityId);
      if (!entity || !incoming.has(entityId)) continue;
      const supported = parentId && cert.capability === 'parsed' && validParent(entity, parentId);
      if (!supported && parentId) complete = false;
      put(entities, entity.id, {
        ...entity, parentId: supported ? parentId : null, ...(!supported ? { ownership: 'unresolved' } : {}),
      }, limits.entities, 'entities');
    }
    // Disappearance needs matching enumeration semantics. Grammar/identity
    // upgrades make old identities stale, even when the source hash is unchanged.
    for (const entityId of previous) {
      if (incoming.has(entityId)) continue;
      const old = entities.get(entityId);
      if (!old) continue;
      const ref = old.sourceRefs.find(ref => ref.artifactId === cert.artifactId);
      const canRetract = complete && ref?.extractor === cert.extractor &&
        ref.extractorVersion === cert.version && ref.identityVersion === cert.identityVersion;
      put(entities, entityId, { ...old, validity: canRetract ? 'retracted' : 'stale', classification: 'stale' }, limits.entities, 'entities');
      invalidateEntitySupport(entityId, canRetract ? 'retracted' : 'stale');
    }
    const enumeration = { ...cert, complete };
    put(artifacts, artifact.id, { ...artifact, enumeration }, limits.artifacts);
    // Containment is represented by parentId; other parser relations remain
    // typed, with support for both endpoints rather than renderer-derived roles.
    const freshRelations = new Set();
    for (const value of (Array.isArray(structure.relations) ? structure.relations : []).slice(0, limits.relations)) {
      if (['contains', 'containment'].includes(value?.kind)) continue;
      const source = entities.get(value?.source), target = entities.get(value?.target);
      if (!source || !target || source.validity !== 'current' || target.validity !== 'current' ||
          source.artifactId !== cert.artifactId || target.artifactId !== cert.artifactId ||
          !currentRefs(source.sourceRefs) || !currentRefs(target.sourceRefs)) continue;
      const relation = relationRecord({
        ...value, basis: cert.capability === 'parsed' ? 'parsed' : 'lexical',
        validity: 'current', sourceRefs: [sourceRef(cert, root, event)],
      }, limits.refs);
      if (relation && admitRelation(relation)) freshRelations.add(relation.id);
    }
    for (const relation of [...relations.values()]) {
      if (relation.kind !== 'imports' && ['parsed', 'lexical'].includes(relation.basis) &&
          relation.sourceRefs.some(ref => ref.artifactId === cert.artifactId) && !freshRelations.has(relation.id)) {
        const sameExtractor = relation.sourceRefs.every(ref => ref.extractor === cert.extractor &&
          ref.extractorVersion === cert.version && ref.identityVersion === cert.identityVersion);
        put(relations, relation.id, { ...relation, validity: complete && sameExtractor ? 'retracted' : 'stale' }, limits.relations, 'relations');
      }
    }
    observeImports(structure.imports, cert, event, complete);
    commit('structure.observed', { artifactIds: [cert.artifactId], ...(id(event?.sessionId) ? { sessionId: event.sessionId } : {}) });
    if (name) scheduleImports(name);
    for (const activity of activities.values()) applyCreation(activity);
    resolveImports();
    return stats();
  }

  function observeImports(values, cert, event, complete) {
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : []).slice(0, limits.imports)) {
      if (!plain(value) || !id(value.id) || entities.get(value.ownerId)?.artifactId !== cert.artifactId ||
          value.artifactId !== cert.artifactId) continue;
      const specifier = typeof value.specifier === 'string' && value.specifier.length <= 256 &&
        /^\.{1,2}\/[A-Za-z0-9_./-]+$/.test(value.specifier) ? value.specifier : null;
      const record = {
        id: value.id, artifactId: cert.artifactId, ownerId: value.ownerId, specifier,
        kind: token(value.kind), sourceRefs: [sourceRef(cert, value, event)], validity: 'current',
        candidates: importCandidates(artifacts.get(cert.artifactId)?.relativePath, specifier),
      };
      if (!put(imports, value.id, record, limits.imports, 'imports')) deferred.imports++;
      else seen.add(value.id);
    }
    for (const value of [...imports.values()]) {
      if (value.artifactId === cert.artifactId && !seen.has(value.id)) {
        if (complete) remove(imports, value.id, 'imports');
        else put(imports, value.id, { ...value, validity: 'stale' }, limits.imports, 'imports');
        const relation = relations.get(key('import', projectId, value.id));
        if (relation) put(relations, relation.id, { ...relation, validity: complete ? 'retracted' : 'stale' }, limits.relations, 'relations');
      }
    }
  }

  function importCandidates(ownerPath, specifier) {
    if (!ownerPath || !specifier) return [];
    const targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), specifier));
    if (!relativePath(targetPath, currentPolicy(policy))) return [];
    const candidates = [targetPath];
    if (!path.posix.extname(targetPath)) {
      candidates.push(...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].map(ext => targetPath + ext));
      candidates.push(...['.js', '.mjs', '.ts', '.tsx'].map(ext => `${targetPath}/index${ext}`));
    }
    return candidates;
  }
  function scheduleImports(name) {
    for (const importId of importTargets.get(name) ?? []) pendingImports.add(importId);
  }
  function resolveImports() {
    for (let count = 0; count < 256 && pendingImports.size; count++) {
      const importId = pendingImports.values().next().value;
      pendingImports.delete(importId);
      const entry = imports.get(importId);
      if (!entry) continue;
      if (!entry.specifier || entry.validity !== 'current' || !currentRefs(entry.sourceRefs)) continue;
      if (!['import', 'reexport', 'dynamic_import'].includes(entry.kind)) {
        const previous = relations.get(key('import', projectId, entry.id));
        if (previous) put(relations, previous.id, { ...previous, validity: 'stale' }, limits.relations, 'relations');
        continue;
      }
      const targets = entry.candidates.map(candidate => files.get(candidate)).filter(Boolean);
      // Ambiguous extension/package resolution stays unknown. No binding-level
      // target, external service, or deployment role is inferred from a name.
      if (targets.length !== 1) {
        const relation = relations.get(key('import', projectId, entry.id));
        if (relation) put(relations, relation.id, { ...relation, validity: 'stale' }, limits.relations, 'relations');
        continue;
      }
      const target = entities.get(targets[0].scopeId);
      if (!target || target.validity !== 'current' || !currentRefs(target.sourceRefs)) continue;
      const refs = [...entry.sourceRefs, ...target.sourceRefs];
      if (refs.length > limits.refs) { deferred.relations++; continue; }
      admitRelation({
        id: key('import', projectId, entry.id), source: entry.ownerId, target: target.id,
        kind: 'imports', basis: 'parsed', validity: 'current', sourceRefs: copy(refs),
      });
    }
  }

  function observeInterpretations(values, { event } = {}) {
    if (!Array.isArray(values) || !currentPolicy(policy).readSource) return stats();
    for (const value of values.slice(0, limits.interpretations)) {
      const record = interpretationRecord(value, limits.refs);
      if (!record || record.entityIds.some(entityId => !entities.has(entityId))) continue;
      if (record.support === 'supported' && (!currentRefs(record.sourceRefs) ||
          record.entityIds.some(entityId => entities.get(entityId).validity !== 'current'))) continue;
      const storageId = key('interpretation', projectId, record.namespace, record.id);
      const normalized = { ...record, id: storageId, validity: record.sourceRefs.length && !currentRefs(record.sourceRefs) ? 'stale' : record.validity };
      if (!put(interpretations, storageId, normalized, limits.interpretations, 'interpretations')) deferred.interpretations++;
    }
    commit('interpretations.observed', { sessionId: event?.sessionId });
    return stats();
  }

  function decisionFreshness(value, sourceRefs, fresh) {
    if (!fresh) return 'stale';
    if (value.validity === 'retracted') return 'retracted';
    if (value.validity !== 'current' || !currentPolicy(policy).readSource || !sourceRefs.length) return 'stale';
    return sourceRefs.every(ref => {
      const artifact = artifacts.get(ref.artifactId);
      return ref.sourceClass !== 'public_intent' && artifact?.status === 'present' &&
        (artifact.fresh || artifact.observed) && sameVersion(artifact, ref);
    }) ? 'current' : 'stale';
  }
  function canonicalDecisionEntity(node, sourceRefs) {
    const matches = new Map();
    for (const ref of sourceRefs) {
      const enumeration = artifacts.get(ref.artifactId)?.enumeration;
      for (const record of dependents.get(ref.artifactId) ?? []) {
        if (entities.get(record.id) !== record || record.basis !== 'parsed' || record.validity !== 'current') continue;
        const qualified = node.qualifiedName ?? node.label;
        const exact = record.qualifiedName === qualified;
        // A bare name is only unique when complete enumeration established all
        // declarations in the artifact. Nested same-name methods remain separate.
        if (exact || enumeration?.complete && record.label === node.label) matches.set(record.id, record);
      }
    }
    return matches.size === 1 ? matches.values().next().value : null;
  }
  function replaceDecisionAlias(oldId, canonicalId) {
    if (oldId === canonicalId || !entities.has(oldId)) return;
    for (const relationId of [...(incident.get(oldId) ?? [])]) {
      const relation = relations.get(relationId);
      put(relations, relationId, {
        ...relation, source: relation.source === oldId ? canonicalId : relation.source,
        target: relation.target === oldId ? canonicalId : relation.target,
      }, limits.relations, 'relations');
    }
    for (const interpretationId of [...(memberships.get(oldId) ?? [])]) {
      const record = interpretations.get(interpretationId);
      put(interpretations, interpretationId, {
        ...record, entityIds: [...new Set(record.entityIds.map(entityId => entityId === oldId ? canonicalId : entityId))],
      }, limits.interpretations, 'interpretations');
    }
    evictEntity(oldId, false);
  }
  function observeLegacy(graph, { sessionId = 'unknown', fresh = false } = {}) {
    if (!plain(graph) || !Array.isArray(graph.nodes) || !id(sessionId)) return stats();
    const mapping = new Map();
    for (const node of graph.nodes.slice(0, limits.entities)) {
      if (!id(node?.id)) continue;
      const legacyId = key('legacy', projectId, sessionId, node.id);
      const sourceRefs = references(node.sourceRefs ?? [], limits.refs) ?? [];
      const validity = decisionFreshness(node, sourceRefs, fresh);
      const canonical = fresh && validity === 'current' ? canonicalDecisionEntity(node, sourceRefs) : null;
      const entityId = canonical?.id ?? legacyId;
      const entity = entityRecord({
        ...node, id: entityId, legacyId: node.id, sessionId, parentId: null,
        kind: token(node.kind), basis: fresh ? 'decision' : 'legacy', validity,
        classification: fresh ? validity === 'current' ? classification(node.classification) : 'stale' : 'unknown',
        sourceRefs, knownAtSequence: entities.get(entityId)?.knownAtSequence ?? sequence + 1,
      }, limits.refs);
      if (canonical) {
        replaceDecisionAlias(legacyId, canonical.id);
        mapping.set(node.id, canonical.id);
      } else if (entity && admitEntity(entity)) mapping.set(node.id, entityId);
      if (fresh && mapping.has(node.id)) {
        const interpretation = interpretationRecord({
          id: key('role', projectId, sessionId, node.id), namespace: 'graphlin.legacy-role',
          kind: node.kind, label: node.label, entityIds: [entityId], sourceRefs, validity,
          classification: entity.classification, version: '1', sessionId,
          support: validity !== 'current' ? 'unknown' : entity.classification === 'accepted' ? 'supported' : 'tentative',
        }, limits.refs);
        if (interpretation && !put(interpretations, interpretation.id, interpretation, limits.interpretations, 'interpretations')) {
          deferred.interpretations++;
        }
      }
    }
    for (const edge of (Array.isArray(graph.edges) ? graph.edges : []).slice(0, limits.relations)) {
      if (!id(edge?.id) || !mapping.has(edge.source) || !mapping.has(edge.target)) continue;
      const sourceRefs = references(edge.sourceRefs ?? [], limits.refs) ?? [];
      const observedValidity = decisionFreshness(edge, sourceRefs, fresh);
      const endpointsCurrent = [mapping.get(edge.source), mapping.get(edge.target)]
        .every(entityId => entities.get(entityId)?.validity === 'current');
      const relation = relationRecord({
        id: key('legacy-relation', projectId, sessionId, edge.id), source: mapping.get(edge.source), target: mapping.get(edge.target),
        kind: edge.kind ?? edge.relation, basis: fresh ? 'decision' : 'legacy',
        validity: observedValidity === 'current' && !endpointsCurrent ? 'stale' : observedValidity, sourceRefs,
      }, limits.refs);
      if (relation) admitRelation(relation);
    }
    commit(fresh ? 'decisions.observed' : 'legacy.observed', { sessionId });
    return stats();
  }

  function recordActivity(event) {
    if (!plain(event)) return stats();
    sequence++;
    appendActivity(event);
    if (applyCreation(activities.get(`${sequence}`))) revision++;
    return stats();
  }
  function applyCreation(event) {
    if (!event?.creation) return false;
    let changed = false;
    for (const entityId of event.entityIds) {
      const entity = entities.get(entityId);
      if (!entity || entity.createdAtSequence || entity.validity !== 'current' ||
          !event.sourceRefs.some(ref => entity.sourceRefs.some(support =>
            support.artifactId === ref.artifactId && sameVersion(support, ref)))) continue;
      changed = put(entities, entityId, { ...entity, createdAtSequence: event.sequence }, limits.entities, 'entities') || changed;
    }
    return changed;
  }

  function setSessions(values = []) {
    if (!Array.isArray(values)) return stats();
    for (const sessionId of [...sessions.keys()]) remove(sessions, sessionId);
    for (const value of values.slice(-limits.sessions)) {
      const sessionId = id(value?.id ?? value?.sessionId);
      if (!sessionId) continue;
      const record = { id: sessionId, host: token(value.host), status: token(value.status), startedAt: time(value.startedAt, 0) };
      if (value.endedAt != null) record.endedAt = time(value.endedAt, 0);
      put(sessions, sessionId, record, limits.sessions);
    }
    commit('sessions.observed');
    return stats();
  }

  function observeLineage(value) {
    const next = lineageRecord(value);
    const changed = !!next && !!lineage && next.id !== lineage.id;
    if (!next || JSON.stringify(next) === JSON.stringify(lineage)) return { changed: false, lineage: copy(lineage) };
    if (changed) {
      // Branch/worktree observations change the authority of current evidence,
      // not the recorded history or the identities we have already discovered.
      for (const [map, type] of [[entities, 'entities'], [relations, 'relations'], [interpretations, 'interpretations'], [imports, 'imports']]) {
        for (const record of map.values()) {
          if (record.validity !== 'current' || record.basis === 'metadata') continue;
          put(map, record.id, {
            ...record, validity: 'stale', ...('classification' in record ? { classification: 'stale' } : {}),
          }, limits[type], type);
        }
      }
      for (const artifact of artifacts.values()) {
        const invalidated = { ...artifact, fresh: false, complete: false };
        delete invalidated.observed;
        if (artifact.enumeration) invalidated.enumeration = {
          ...artifact.enumeration, complete: false, coveredRanges: [], omissions: ['lineage_changed'],
        };
        if (!put(artifacts, artifact.id, invalidated, limits.artifacts)) {
          // At the byte cap, discard an optional certificate rather than leave
          // a complete absence proof attached to a different lineage.
          delete invalidated.enumeration;
          put(artifacts, artifact.id, invalidated, limits.artifacts);
        }
      }
      pendingImports.clear();
    }
    lineage = next;
    commit('lineage.observed');
    return { changed, lineage: copy(lineage) };
  }

  function coverage() {
    let resolved = 0;
    for (const value of imports.values()) if (relations.get(key('import', projectId, value.id))?.validity === 'current') resolved++;
    return {
      ...inventoryCoverage, inspected: artifacts.size, retained: entities.size, deferred: copy(deferred),
      inventoryDeferred: inventoryCoverage.deferred, scopes: [...scopes.values()],
      files: [...files.values()], enumerations: [...artifacts.values()].flatMap(value => value.enumeration ? [value.enumeration] : []),
      artifacts: [...artifacts.values()].map(({ enumeration, ...value }) => value),
      relationships: { observed: imports.size, resolved, unresolved: imports.size - resolved, deferred: pendingImports.size },
      ...(lineage ? { lineage } : {}),
      oldestSequence: activities.values().next().value?.sequence ?? sequence,
      truncated: Object.values(deferred).some(Boolean) || !inventoryCoverage.complete,
    };
  }
  function rawSnapshot() {
    return {
      schemaVersion: 2, projectId, revision, sequence, entities: [...entities.values()], relations: [...relations.values()],
      interpretations: [...interpretations.values()], activity: [...activities.values()], coverage: coverage(),
      sessions: [...sessions.values()], checkpoints: [...checkpoints.values()].map(value => value.marker),
    };
  }
  function snapshot({ persistent = false, sessionId, checkpointId, scopeId } = {}) {
    const checkpoint = checkpointId ? checkpoints.get(checkpointId) : null;
    if (checkpointId && !checkpoint) fail('MODEL_CHECKPOINT_UNAVAILABLE');
    const options = { persistent, sessionId, scopeId };
    const effectivePolicy = currentPolicy(policy);
    const result = projectSnapshot(checkpoint?.state ?? rawSnapshot(), effectivePolicy, options);
    if (persistent && !checkpointId) {
      result.checkpoints = [...checkpoints.values()].map(value => ({
        ...projectSnapshot({ ...value.state, checkpoints: [value.marker] }, effectivePolicy, options).checkpoints[0],
        state: projectSnapshot(value.state, effectivePolicy, options),
      }));
    }
    return copy(result);
  }
  function checkpoint({ label: checkpointLabel, sessionId } = {}) {
    const marker = {
      id: key('checkpoint', projectId, revision, sequence + 1),
      label: label(checkpointLabel, 'Checkpoint'), projectId, revision, sequence: sequence + 1, at: time(clock()),
      ...(id(sessionId) ? { sessionId } : {}),
    };
    const state = copy({ ...rawSnapshot(), sequence: sequence + 1 });
    state.checkpoints.push(marker);
    const size = byteSize(state);
    if (size > limits.checkpointBytes || size + bytes > limits.bytes) fail('MODEL_CHECKPOINT_CAPACITY');
    while (checkpoints.size >= limits.checkpoints || historyBytes + size > limits.checkpointBytes ||
      bytes + historyBytes + size > limits.bytes) {
      const first = checkpoints.keys().next().value;
      historyBytes -= checkpoints.get(first).bytes;
      checkpoints.delete(first);
    }
    sequence++;
    checkpoints.set(marker.id, { marker, state, bytes: size });
    historyBytes += size;
    return copy(marker);
  }
  function changes(checkpointId) {
    const checkpoint = checkpoints.get(checkpointId);
    if (!checkpoint) fail('MODEL_CHECKPOINT_UNAVAILABLE');
    // Compare protected records before redaction: tightening labels must not
    // manufacture edits. Project only the returned records with current policy.
    const current = rawSnapshot(), effectivePolicy = currentPolicy(policy);
    const raw = compareCheckpoint(checkpoint.state, current, checkpointId);
    const oldEntities = new Map(projectSnapshot(checkpoint.state, effectivePolicy).entities.map(value => [value.id, value]));
    const newEntities = new Map(projectSnapshot(current, effectivePolicy).entities.map(value => [value.id, value]));
    for (const name of ['discoveries', 'creations', 'removals', 'invalidations']) {
      raw[name] = raw[name].map(value => newEntities.get(value.id));
    }
    raw.modifications = raw.modifications.map(value => ({
      before: oldEntities.get(value.before.id), after: newEntities.get(value.after.id),
    }));
    return copy(raw);
  }
  function stats() {
    return {
      projectId, revision, sequence, entities: entities.size, relations: relations.size,
      interpretations: interpretations.size, artifacts: artifacts.size, inventory: files.size,
      activity: activities.size, sessions: sessions.size, checkpoints: checkpoints.size,
      bytes: bytes + historyBytes, historyBytes, softLimitReached: bytes + historyBytes > limits.softBytes,
      deferred: copy(deferred), limits: copy(limits),
    };
  }

  function restore(state) {
    if (!plain(state)) return;
    if (state.schemaVersion !== 2) {
      if (Array.isArray(state.nodes)) observeLegacy(state, { sessionId: 'restored' });
      return;
    }
    if (state.projectId !== projectId) fail('MODEL_PROJECT_MISMATCH');
    revision = integer(state.revision) ? state.revision : 0;
    sequence = integer(state.sequence) ? state.sequence : 0;
    lineage = lineageRecord(state.coverage?.lineage);
    for (const value of (Array.isArray(state.entities) ? state.entities : []).slice(0, limits.entities)) {
      const entity = entityRecord(value, limits.refs);
      if (!entity) continue;
      if (entity.basis !== 'metadata') { entity.validity = 'stale'; entity.classification = 'stale'; }
      admitEntity(entity);
    }
    for (const entity of [...entities.values()]) {
      const seen = new Set([entity.id]);
      let parent = entities.get(entity.parentId), cycle = false;
      while (parent) {
        if (seen.has(parent.id) || seen.size > 256) { cycle = true; break; }
        seen.add(parent.id);
        parent = entities.get(parent.parentId);
      }
      if (entity.parentId && (cycle || !entities.has(entity.parentId) || entity.artifactId &&
          entities.get(entity.parentId).basis !== 'metadata' && !validParent(entity, entity.parentId))) {
        put(entities, entity.id, { ...entity, parentId: null, ownership: 'unresolved' }, limits.entities, 'entities');
      }
    }
    for (const value of (Array.isArray(state.relations) ? state.relations : []).slice(0, limits.relations)) {
      const record = relationRecord(value, limits.refs);
      if (record) admitRelation({ ...record, validity: 'stale' });
    }
    for (const value of (Array.isArray(state.interpretations) ? state.interpretations : []).slice(0, limits.interpretations)) {
      const record = interpretationRecord(value, limits.refs);
      if (record && record.entityIds.every(entityId => entities.has(entityId))) {
        put(interpretations, record.id, { ...record, validity: 'stale', classification: 'stale' }, limits.interpretations, 'interpretations');
      }
    }
    const certificates = new Map((Array.isArray(state.coverage?.enumerations) ? state.coverage.enumerations : [])
      .slice(0, limits.artifacts).map(value => certificate(value)).filter(Boolean).map(value => [value.artifactId, value]));
    for (const value of (Array.isArray(state.coverage?.artifacts) ? state.coverage.artifacts : []).slice(0, limits.artifacts)) {
      if (!id(value?.id) || !integer(value.generation, 1)) continue;
      const cert = certificates.get(value.id);
      const name = relativePath(value.relativePath, currentPolicy(policy));
      put(artifacts, value.id, {
        id: value.id, hash: /^[a-f0-9]{64}$/.test(value.hash) ? value.hash : null, generation: value.generation,
        status: 'present', fresh: false, complete: false, ...(name ? { relativePath: name } : {}),
        ...(cert ? { enumeration: { ...cert, complete: false } } : {}),
      }, limits.artifacts);
    }
    for (const value of (Array.isArray(state.coverage?.files) ? state.coverage.files : []).slice(0, limits.artifacts)) {
      const name = relativePath(value?.relativePath, currentPolicy(policy));
      if (!name || !id(value.scopeId)) continue;
      const parentId = ensureDirectory(path.posix.dirname(name));
      put(files, name, {
        id: key('inventory', projectId, name), relativePath: name, root: relativePath(value.root) ?? '',
        kind: token(value.kind, 'file'), size: integer(value.size) ? value.size : 0, mtimeMs: 0,
        scopeId: value.scopeId, parentId, ...(id(value.artifactId) ? { artifactId: value.artifactId } : {}),
      }, limits.artifacts);
    }
    for (const value of (Array.isArray(state.activity) ? state.activity : []).slice(-limits.activity)) {
      if (!integer(value.sequence) || value.sequence > sequence) continue;
      const record = activityRecord(value, value.sequence, Date.parse(value.recordedAt));
      if (record) put(activities, `${value.sequence}`, record, limits.activity);
    }
    for (const value of (Array.isArray(state.sessions) ? state.sessions : []).slice(-limits.sessions)) {
      if (id(value?.id)) put(sessions, value.id, {
        id: value.id, host: token(value.host), status: token(value.status), startedAt: time(value.startedAt, 0),
      }, limits.sessions);
    }
    // History retains recorded validity. It never enters the live evidence
    // registry or gains authority to approve a new decision after restart.
    for (const value of (Array.isArray(state.checkpoints) ? state.checkpoints : []).slice(-limits.checkpoints)) {
      if (!id(value?.id) || value.projectId !== projectId || !plain(value.state) ||
          !integer(value.sequence) || value.sequence > sequence || value.state.sequence !== value.sequence ||
          value.state.revision !== value.revision) continue;
      const restored = restoreFrozenSnapshot(value.state, { projectId, limits });
      if (!restored) continue;
      const marker = { id: value.id, label: label(value.label, 'Checkpoint'), projectId,
        revision: restored.revision, sequence: restored.sequence, at: time(value.at, 0),
        ...(id(value.sessionId) ? { sessionId: value.sessionId } : {}) };
      const size = byteSize(restored);
      if (historyBytes + size <= limits.checkpointBytes && bytes + historyBytes + size <= limits.bytes) {
        checkpoints.set(marker.id, { marker, state: restored, bytes: size });
        historyBytes += size;
      }
    }
  }
  restore(restoredState);
  return Object.freeze({
    observeInventory, observeStructure, invalidateArtifacts, observeLegacy, observeInterpretations,
    recordActivity, setSessions, observeLineage, snapshot, checkpoint, changes, stats,
  });
}
