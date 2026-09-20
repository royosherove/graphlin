import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256, MANIFEST_FILE } from '../../runtime/extensions/index.mjs';

export const PROJECT = 'project-synthetic';
export const SOURCE = 'window.addEventListener("graphlin:connect", event => { event.detail.port.start(); });';
export const profile = {
  id: 'architecture',
  questions: [
    { id: 'application', kind: 'boolean', question: 'Does the supplied evidence support an application boundary?' },
    { id: 'role', kind: 'choice', question: 'Which supplied role is supported?', options: ['application', 'datastore', 'unknown'] },
    { id: 'support', kind: 'score', question: 'How strongly do the supplied observations support that role?' },
  ],
  selectors: { fields: ['entities', 'relations'], candidateIds: ['gateway'] },
};
export function packageFiles({ version = '1.0.0', source = SOURCE, extra = {}, manifest: overrides = {} } = {}) {
  const assets = { 'dist/visualizer.js': Buffer.from(source), ...extra };
  const manifest = {
    manifestVersion: 1, id: 'example.c4', name: 'Synthetic C4', version,
    graphlinApi: '1', modelSchema: '2', requiredFeatures: ['containment', 'canonical-mappings'],
    entry: 'dist/visualizer.js', views: ['context', 'components'],
    renderer: { kind: 'graphlin-scene', sceneVersion: '1' },
    capabilities: ['model.read', 'activity.read', 'selection.request', 'history.read'],
    assets: Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, `sha256-${sha256(bytes)}`])),
    ...overrides,
  };
  return {
    manifest, assets,
    files: {
      [MANIFEST_FILE]: Buffer.from(JSON.stringify(manifest)),
      'package.json': Buffer.from(JSON.stringify({ name: 'synthetic-c4', version,
        scripts: { prepack: 'touch DO-NOT-RUN', install: 'touch DO-NOT-RUN' } })),
      ...assets,
    },
  };
}
export async function temporary(t) {
  // macOS /var and /tmp are system aliases, resolved before constructing fixture paths.
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin-extensions-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
export async function localPackage(t, options = {}) {
  const root = await temporary(t), directory = path.join(root, 'package');
  await mkdir(directory, { mode: 0o700 });
  const data = packageFiles(options);
  for (const [name, bytes] of Object.entries(data.files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, name), bytes);
  }
  return { ...data, directory, root, dataDir: path.join(root, 'state') };
}
export function tar(entries, { gzip = false } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    const number = (value, start, size) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', start, size);
    number(0o644, 100, 8); number(0, 108, 8); number(0, 116, 8);
    number(bytes.length, 124, 12); number(0, 136, 12);
    header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const result = Buffer.concat(blocks);
  return gzip ? gzipSync(result) : result;
}
export const archive = files => tar(Object.entries(files).map(([name, bytes]) => ({ name: `package/${name}`, bytes })), { gzip: true });
export function model() {
  const ref = { artifactId: 'artifact-gateway', hash: 'a'.repeat(64), generation: 1, startLine: 1, endLine: 4 };
  return {
    schemaVersion: 2, projectId: PROJECT, revision: 7, sequence: 11,
    entities: [
      { id: 'project', label: 'Synthetic gateway', kind: 'project', parentId: null, sourceRefs: [], basis: 'parsed', validity: 'current', classification: 'accepted' },
      { id: 'gateway', label: 'Gateway application', kind: 'service', parentId: 'project', artifactId: 'artifact-gateway',
        qualifiedName: 'Gateway', sourceRefs: [ref], basis: 'parsed', validity: 'current', classification: 'accepted' },
      { id: 'store', label: 'Session store', kind: 'datastore', parentId: 'project', sourceRefs: [ref],
        basis: 'decision', validity: 'current', classification: 'tentative' },
    ],
    relations: [{ id: 'writes-store', source: 'gateway', target: 'store', kind: 'writes',
      basis: 'parsed', validity: 'current', sourceRefs: [ref] }],
    interpretations: [{ id: 'architecture', namespace: 'example.c4.architecture', version: '1',
      kind: 'application', label: 'Supported application', entityIds: ['gateway'], basis: 'decision',
      validity: 'current', classification: 'accepted', support: 'supported', sourceRefs: [ref] }],
    activity: [{ id: 'activity-1', kind: 'tool.requested', sequence: 11, knownAtSequence: 11,
      at: '2026-09-20T10:00:00.000Z', recordedAt: '2026-09-20T10:00:00.000Z',
      sessionId: 'session-1', agentId: 'agent-1', toolCategory: 'read', outcome: 'pending',
      attribution: 'observed', entityIds: ['gateway'], artifactIds: ['artifact-gateway'], sourceRefs: [] }],
    coverage: { total: 20, inspected: 3, deferred: 17, complete: false, scopes: [{ id: 'project', label: 'Project', total: 20 }] },
    sessions: [{ id: 'session-1', host: 'demo', startedAt: '2026-09-20T10:00:00.000Z' }],
    checkpoints: [{ id: 'checkpoint-1', label: 'Before task', revision: 1, sequence: 1, at: '2026-09-20T09:00:00.000Z' }],
  };
}
export function c4Scene(snapshot = model()) {
  return {
    sceneVersion: 1,
    nodes: snapshot.entities.filter(entity => entity.id !== 'project').map(entity => ({
      id: `node-${entity.id}`, entityId: entity.id, label: entity.label, kind: entity.kind,
      parentId: 'group-project', style: entity.classification === 'tentative' ? 'tentative' : 'default',
    })),
    groups: [{ id: 'group-project', entityIds: snapshot.entities.map(entity => entity.id), label: 'Synthetic gateway', parentId: null }],
    edges: [{ id: 'edge-store', source: 'node-gateway', target: 'node-store', kind: 'writes', relationIds: ['writes-store'], count: 1 }],
    coverage: { shown: 3, total: 20, truncated: true },
  };
}
