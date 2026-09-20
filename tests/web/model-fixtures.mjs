export const ref = (hash = 'a'.repeat(64), generation = 1) => ({
  artifactId: 'artifact.one', hash, generation, startLine: 1, endLine: 20,
});
export const entity = (id, parentId = null, extra = {}) => ({
  id, parentId, label: id, kind: 'module', sourceRefs: [ref()],
  basis: 'parsed', validity: 'current', classification: 'accepted', artifactId: 'artifact.one', ...extra,
});
export const relation = (id, source, target, kind = 'calls') => ({
  id, source, target, kind, basis: 'parsed', validity: 'current', sourceRefs: [ref()],
});
export const model = (extra = {}) => ({
  schemaVersion: 2, projectId: 'project.fixture', revision: 1, sequence: 1,
  entities: [entity('root', null, { kind: 'directory', basis: 'metadata', sourceRefs: [] }),
    entity('api', 'root', { kind: 'module' }), entity('run', 'api', { kind: 'function' }),
    entity('store', 'root', { kind: 'class' }), entity('save', 'store', { kind: 'method' })],
  relations: [relation('call', 'run', 'save'), relation('write', 'run', 'save', 'writes')],
  interpretations: [], activity: [], coverage: { enumerations: [], counts: { inventoried: 2, inspected: 2, deferred: 0 } },
  sessions: [{ id: 'session.one' }], checkpoints: [],
  ...extra,
});
