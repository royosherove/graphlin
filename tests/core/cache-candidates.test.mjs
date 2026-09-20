import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, createPolicy, metadataEvent } from '../../runtime/core/index.mjs';
import { hash, opaque } from '../../runtime/core/common.mjs';
import { lexicalHints } from '../../runtime/core/lexical.mjs';

// Synthetic source, never executed. This isolates the environment-prefix
// shortcut from capture, classification, candidate limits, and later calls.
function select(text) {
  return buildCandidates({
    event: metadataEvent({ kind: 'artifact.changed', incomplete: false }),
    policy: createPolicy({ transmitSource: true }),
    artifacts: [{
      id: opaque('artifact', 'cache-candidates-regression'),
      relativePath: 'src/cache.ts', hash: hash(text), generation: 1,
      status: 'present', exists: true, complete: true, text,
    }],
  });
}

test('an environment-guarded constructor retains its declared cache binding', () => {
  const text = [
    'import Redis from "ioredis";',
    'const REDIS_URL = process.env.REDIS_URL;',
    'export const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;',
  ].join('\n');
  const candidates = select(text);
  assert.ok(candidates.some(candidate => candidate.label === 'Redis'));
  assert.ok(!candidates.some(candidate => candidate.label === 'REDIS_URL'),
    'a direct scalar environment lookup should remain excluded');
  const receiver = candidates.find(candidate => candidate.label === 'redis');
  assert.ok(receiver, 'a conditional constructor binding must not be discarded as an environment value');
  assert.equal(receiver.labelOrigin.startLine, 3);
  assert.equal(receiver.text, text);
});

test('bare environment lookups stay excluded while conditional and logical initializers retain bindings', () => {
  for (const lookup of ['process.env.CACHE_URL', 'process.env["CACHE_URL"]', 'import.meta.env.CACHE_URL']) {
    const plain = select(`const location = ${lookup}`);
    assert.ok(!plain.some(candidate => candidate.label === 'location'), lookup);
    const nextDeclaration = select(`const location = ${lookup}\nexport function load() { return null; }`);
    assert.deepEqual(nextDeclaration.map(candidate => candidate.label), ['load']);
    for (const operator of ['? new Adapter() : null', '&& new Adapter()', '|| fallback', '?? fallback']) {
      const text = `import Adapter from "cache-driver";\nexport const client = ${lookup}\n${operator};`;
      const candidates = select(text);
      const client = candidates.find(candidate => candidate.label === 'client');
      assert.ok(client, `${lookup} ${operator}`);
      assert.equal(client.labelOrigin.startLine, 2);
      assert.equal(client.text, text);
    }
  }
});

test('complete typed cache declarations keep their receiver origin before later method calls', () => {
  const text = `import Adapter from "cache-driver";
const cache = process.env.CACHE_URL ? new Adapter(process.env.CACHE_URL) : null;
export async function readCache<T>(): Promise<T | null> {
  return cache ? cache.get("item") : null;
}
export async function writeCache(value: unknown): Promise<void> {
  if (cache) await cache.set("item", value);
}
export async function clearCache(): Promise<void> {
  if (cache) await cache.del("item");
}`;
  const candidates = select(text);
  assert.deepEqual(candidates.map(candidate => candidate.label),
    ['readCache', 'writeCache', 'clearCache', 'cache', 'Adapter']);
  assert.equal(candidates.find(candidate => candidate.label === 'cache').labelOrigin.startLine, 2);
  const hints = lexicalHints(text);
  assert.equal(hints.entities.find(entity => entity.label === 'cache').rank, 1);
  assert.deepEqual(hints.pairs.map(({ source, target }) => ({ source, target })), [
    { source: 'readCache', target: 'cache' },
    { source: 'writeCache', target: 'cache' },
    { source: 'clearCache', target: 'cache' },
  ]);
});
