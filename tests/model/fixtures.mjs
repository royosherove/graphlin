import { hash } from '../../runtime/core/common.mjs';

export const sourceHash = generation => hash(`synthetic source version ${generation}`);
export function structure({
  artifactId = 'artifact-demo', relativePath = 'src/demo.js', generation = 1, complete = true,
  version = 'tree-sitter-wasms@1/javascript/pinned', identityVersion = 'identity-1',
  symbols = [
    { id: 'class-a', label: 'Alpha', kind: 'class', parentId: 'module-demo', startLine: 2, endLine: 20 },
    { id: 'method-a', label: 'run', kind: 'method', parentId: 'class-a', startLine: 3, endLine: 8 },
    { id: 'class-b', label: 'Beta', kind: 'class', parentId: 'module-demo', startLine: 22, endLine: 40 },
    { id: 'method-b', label: 'run', kind: 'method', parentId: 'class-b', startLine: 23, endLine: 28 },
  ],
  scopeId = 'module-demo', imports = [], relations = [], capability = 'parsed',
} = {}) {
  return {
    entities: [
      { id: scopeId, label: relativePath.split('/').at(-1), kind: 'module', parentId: null, artifactId,
        startLine: 1, endLine: 100_000, qualifiedName: relativePath },
      ...symbols.map(value => ({ ...value, artifactId, qualifiedName: `${relativePath}:${value.id}` })),
    ],
    relations, imports,
    enumeration: {
      complete, extractor: 'tree-sitter', version, scopeId, omissions: complete ? [] : ['partial_capture'],
      artifactId, hash: sourceHash(generation), generation, identityVersion,
      coveredRanges: [{ startLine: 1, endLine: 100_000 }], capability,
    },
  };
}
export const file = relativePath => ({ relativePath, kind: 'file', size: 100, mtimeMs: 10, root: relativePath.split('/')[0] });
export const ref = (artifactId = 'artifact-demo', generation = 1) => ({ artifactId, generation, hash: sourceHash(generation) });
export const interpretation = (overrides = {}) => ({
  id: 'answer', namespace: 'example.responsibility', kind: 'membership', label: 'Request handling',
  entityIds: ['class-a'], sourceRefs: [ref()], validity: 'current',
  classification: 'accepted', support: 'supported', version: '1', ...overrides,
});
