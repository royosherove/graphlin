import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, buildModuleCandidates, createPolicy, metadataEvent } from '../../runtime/core/index.mjs';
import { validCandidate, validBundle } from '../../runtime/core/candidates.mjs';
import { LIMITS, hash, opaque } from '../../runtime/core/common.mjs';
import { createDecisionService, DEFAULT_LIMITS } from '../../runtime/decisions/index.mjs';
import { ARCHITECTURE_PROFILES, ROLE_PROFILE_ID } from '../../runtime/architecture/profile.mjs';
import { createRecordedProvider } from '../decisions/recorded-provider.mjs';
import { jevProvider } from '../decisions/jev-provider.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ kind: 'artifact.changed', incomplete: false });
const artifact = text => ({
  id: opaque('artifact', 'synthetic-module-context'), relativePath: 'main.tsx',
  text, hash: hash(text), generation: 7, status: 'present', exists: true, complete: true,
});
const build = (text, overrides = {}) => buildModuleCandidates({ event, artifact: artifact(text), policy, ...overrides });
const context = count => Array.from({ length: count }, (_, index) => `// synthetic context line ${index + 1}`);

function exactSpans(candidates, source) {
  const lines = source.text.split('\n');
  for (const candidate of candidates) {
    assert.equal(candidate.text, lines.slice(candidate.startLine - 1, candidate.endLine).join('\n'));
    assert.ok(candidate.endLine - candidate.startLine < LIMITS.snippetLines);
    assert.ok(candidate.text.length <= LIMITS.snippetChars);
    assert.ok(Buffer.byteLength(JSON.stringify(candidate.text)) <= LIMITS.snippetChars);
    assert.equal(candidate.label, 'Module');
    assert.deepEqual(candidate.labelOrigin, { type: 'generic', label: 'Module' });
    assert.deepEqual(candidate.sourceRef, {
      type: 'artifact', artifactId: source.id, hash: source.hash, generation: source.generation,
    });
    assert.equal(validCandidate(candidate, policy), true);
    assert.equal(validCandidate({ ...candidate, text: candidate.text + ' ' }, policy), false);
  }
  assert.equal(new Set(candidates.map(value => value.id)).size, candidates.length);
  assert.equal(new Set(candidates.map(value => value.entityKey)).size, candidates.length);
}

test('all 283 lines of a module fit as 12 distinct contiguous context candidates, including bootstrap', () => {
  const lines = context(283);
  lines[0] = "import { createRoot } from 'react-dom/client';";
  lines[282] = "createRoot(document.getElementById('root')).render(<App />);";
  const source = artifact(lines.join('\n'));
  const result = build(source.text);
  assert.equal(result.candidates.length, 12);
  assert.equal(result.omitted, 0);
  exactSpans(result.candidates, source);
  assert.equal(result.candidates.map(value => value.text).join('\n'), source.text);
  assert.ok(result.candidates.every(value => value.complete));
  assert.match(result.candidates.at(-1).text, /createRoot.*render/);
  assert.ok(Object.isFrozen(result.candidates[0].sourceRef));
});

test('over-budget modules keep two head and ten tail spans in source order and count missing context', () => {
  const lines = context(24 * 16);
  lines[lines.length - 1] = 'startSyntheticApplication();';
  const source = artifact(lines.join('\n'));
  const result = build(source.text);
  assert.equal(result.candidates.length, 12);
  assert.equal(result.omitted, 4);
  assert.deepEqual(result.candidates.map(value => value.startLine), [1, 25,
    ...Array.from({ length: 10 }, (_, index) => 145 + index * 24)]);
  exactSpans(result.candidates, source);
  assert.ok(result.candidates.every(value => !value.complete));
  assert.match(result.candidates.at(-1).text, /startSyntheticApplication/);
  assert.equal(result.candidates.some(value => value.text.includes('context line 100\n')), false);
});

test('character limits skip oversized lines without joining across the gap or inventing line numbers', () => {
  const text = ['const opening = 1;', 'x'.repeat(1801), 'const resumed = 2;',
    '// ' + 'y'.repeat(997), '// ' + 'z'.repeat(997)].join('\n');
  const result = build(text);
  assert.equal(result.omitted, 1);
  assert.deepEqual(result.candidates.map(value => [value.startLine, value.endLine]), [[1, 1], [3, 4], [5, 5]]);
  exactSpans(result.candidates, artifact(text));
  assert.ok(result.candidates.every(value => !value.complete));
  for (const newline of ['const one = 1;\n\nconst two = 2;\n',
    context(24).join('\n') + '\n', context(24 * 11).join('\n') + '\n', 'x'.repeat(1796) + '\n']) {
    const preserved = build(newline);
    assert.equal(preserved.omitted, 0);
    assert.ok(preserved.candidates.length <= 12);
    exactSpans(preserved.candidates, artifact(newline));
    assert.equal(preserved.candidates.map(value => value.text).join('\n'), newline);
  }
  const unrepresentable = build('x'.repeat(1798) + '\n');
  assert.equal(unrepresentable.omitted, 1, 'an unrepresentable empty trailing span is reported, never silently dropped');
  assert.equal(unrepresentable.candidates[0].complete, false);
});

test('multibyte and JSON-escaped module context fits complete A/B requests, including the Jev wire envelope', async t => {
  for (const payload of ['界'.repeat(68), '"\\\t'.repeat(200)]) {
    const text = Array.from({ length: 24 * 12 }, (_, index) => `// ${index} ${payload}`).join('\n');
    const { candidates, omitted } = build(text);
    assert.equal(candidates.length, 12);
    assert.ok(omitted > 0);
    exactSpans(candidates, artifact(text));
    for (const delegate of [createRecordedProvider(), jevProvider()]) {
      const wireSizes = [];
      const provider = { ...delegate, encode(request) {
        const body = delegate.encode(request);
        wireSizes.push(Buffer.byteLength(body));
        return body;
      } };
      const service = createDecisionService({ provider, profiles: ARCHITECTURE_PROFILES });
      t.after(() => service.close());
      const result = await service.analyze({ event, candidates, policy, profileId: ROLE_PROFILE_ID });
      assert.equal(result.analysis.status, 'answered');
      assert.equal(delegate.calls.length, 2, 'both A and B dispatch instead of failing request_too_large');
      assert.equal(wireSizes.length, 2);
      assert.ok(wireSizes.every(size => size <= DEFAULT_LIMITS.maxRequestBytes));
      assert.deepEqual(delegate.calls[1].request.state.evidence.map(value => value.code),
        candidates.map(value => value.text));
    }
  }
});

test('single lines over the encoded byte budget are omissions even when their character count fits', () => {
  const text = ['opening();', '界'.repeat(600), '"'.repeat(900), 'startSyntheticApplication();'].join('\n');
  const result = build(text);
  assert.equal(result.omitted, 2);
  assert.deepEqual(result.candidates.map(value => [value.startLine, value.endLine]), [[1, 1], [4, 4]]);
  exactSpans(result.candidates, artifact(text));
  assert.ok(result.candidates.every(value => !value.complete));
});

test('whitespace-only tails cannot evict the last executable module fragment', () => {
  const lines = [...context(24 * 14), 'startSyntheticApplication();', ...Array(24 * 20).fill('   ')];
  const source = artifact(lines.join('\n'));
  const result = build(source.text);
  assert.equal(result.candidates.length, 12);
  assert.equal(result.omitted, 23, 'three nonblank windows and twenty blank windows are omitted');
  assert.ok(result.candidates.every(value => value.text.trim() && !value.complete));
  assert.match(result.candidates.at(-1).text, /startSyntheticApplication/);
  exactSpans(result.candidates, source);
  const blank = build(Array(48).fill('   ').join('\n'));
  assert.deepEqual(blank, { candidates: [], omitted: 2 });
});

test('module extraction retains consent, secret, path, complete-capture and exact-version gates', () => {
  const source = artifact('export function visible() { return 1; }');
  for (const overrides of [
    { policy: createPolicy({ readSource: true }) },
    { event: { ...event, kind: 'tool.requested' } },
    { event: { ...event, kind: 'capture.gap' } },
    { artifact: { ...source, relativePath: '.env.local' } },
    { artifact: { ...source, complete: false } },
    { artifact: { ...source, status: 'missing', exists: false } },
    { artifact: { ...source, generation: 0 } },
    { artifact: { ...source, hash: 'a'.repeat(64) } },
    { artifact: { ...source, text: null } },
    { artifact: artifact('é'.repeat(150_000)) },
    { artifact: artifact('const apiKey = "SYNTHETIC_PRIVATE_VALUE";\n' + context(300).join('\n')) },
  ]) assert.deepEqual(build(source.text, overrides), { candidates: [], omitted: 0 });
  assert.deepEqual(buildModuleCandidates({ event, policy, publicText: source.text }), { candidates: [], omitted: 0 });
});

test('the ordinary A/B service cannot send an intake-rejected module fragment to B', async t => {
  for (const all of [false, true]) {
    const text = context(72).join('\n'), { candidates } = build(text);
    const provider = createRecordedProvider({ transform(value, request) {
      if (request.questions.a_activity) {
        for (let index = 0; index < candidates.length; index++) {
          if (all || index === 1) value.answers[`a_sensitive_${index}`].probability = 0.99;
        }
      }
      return value;
    } });
    const service = createDecisionService({ provider, profiles: ARCHITECTURE_PROFILES });
    t.after(() => service.close());
    const result = await service.analyze({ event, candidates, policy, profileId: ROLE_PROFILE_ID });
    assert.equal(validBundle(result.bundle, policy), true);
    assert.equal(validBundle(structuredClone(result.bundle), policy), false);
    assert.equal(provider.calls.length, all ? 1 : 2);
    assert.deepEqual(provider.calls[0].request.state.evidence.map(value => value.code),
      candidates.map(value => value.text));
    if (all) assert.equal(result.bundle.candidates.length, 0);
    else assert.deepEqual(provider.calls[1].request.state.evidence.map(value => value.code),
      [candidates[0].text, candidates[2].text]);
  }
});

test('legacy extraction still deduplicates the generic Module instead of adopting context spans', () => {
  const source = artifact(context(72).join('\n'));
  const input = { event, policy, artifacts: [source] };
  const legacy = buildCandidates(input);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].label, 'Module');
  assert.equal(legacy[0].entityKey, opaque('entity', source.id, 'generic', 'Module'));
  assert.equal(legacy[0].startLine, 1);
  assert.equal(legacy[0].endLine, 24);
  assert.equal(build(source.text).candidates.length, 3);
  assert.deepEqual(buildCandidates(input), legacy);
});
