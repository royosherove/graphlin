import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, opaque } from '../../runtime/core/common.mjs';
import { extractStructure } from '../../runtime/discovery/index.mjs';

const run = promisify(execFile);
const extract = (relativePath, text, options = {}) => extractStructure({
  artifactId: opaque('artifact', relativePath), relativePath, text, hash: hash(text), generation: 1, ...options,
});
function assertForest(result) {
  const byId = new Map(result.entities.map(entity => [entity.id, entity]));
  assert.equal(byId.size, result.entities.length);
  for (const entity of result.entities) {
    const seen = new Set([entity.id]);
    let child = entity;
    while (child.parentId) {
      const parent = byId.get(child.parentId);
      assert.ok(parent, 'parent exists');
      assert.ok(parent.startLine <= child.startLine && parent.endLine >= child.endLine, 'parent encloses child');
      assert.ok(!seen.has(parent.id), 'no cycles');
      seen.add(parent.id); child = parent;
    }
  }
  assert.equal(result.relations.length, result.entities.length - 1);
  assert.ok(result.relations.every(relation => relation.kind === 'contains' && byId.has(relation.source) && byId.has(relation.target)));
}

test('nested same-name methods, functions, and object owners remain distinct', async () => {
  const source = `class Gateway {
  run() {
    class Session { run() { function inner() {} } }
    function nested() {}
  }
}
class Scheduler { run() {} }
const client = { run() {}, cache: { run() {} } };
`;
  const result = await extract('gateway.js', source);
  assert.equal(result.enumeration.complete, true);
  assert.equal(result.enumeration.capability, 'parsed');
  const methods = result.entities.filter(entity => entity.label === 'run');
  assert.equal(methods.length, 5);
  assert.equal(new Set(methods.map(entity => entity.id)).size, 5);
  assert.deepEqual(methods.map(entity => entity.qualifiedName), [
    'gateway.js::Gateway::run', 'gateway.js::Gateway::run::Session::run',
    'gateway.js::Scheduler::run', 'gateway.js::client::run', 'gateway.js::client::cache::run',
  ]);
  assertForest(result);
});

test('identity ignores body edits, line movement, generations, and unrelated siblings', async () => {
  const before = await extract('gateway.ts', 'class Gateway { run() { return 1; } }');
  const after = await extract('gateway.ts', '// moved\nconst utility = 1;\nclass Gateway {\n run() {\n const value = 2;\n return value;\n }\n}', { generation: 8 });
  for (const entity of before.entities) assert.equal(after.entities.find(item => item.qualifiedName === entity.qualifiedName)?.id, entity.id);
  assert.notEqual(before.enumeration.hash, after.enumeration.hash);
  assert.equal(after.enumeration.generation, 8);
  const other = await extract('gateway.ts', 'class Gateway { run() { return 1; } }', { artifactId: opaque('artifact', 'different-worktree') });
  assert.ok(other.entities.every(entity => !before.entities.some(previous => previous.id === entity.id)));
});

test('an empty current capture can completely enumerate absence of declarations', async () => {
  const result = await extract('empty.py', '');
  assert.equal(result.entities.length, 1);
  assert.equal(result.enumeration.complete, true);
  assert.deepEqual(result.enumeration.coveredRanges, [{ startLine: 1, endLine: 1 }]);
});

test('TS namespaces, interfaces, types, enums, class fields, and TSX arrows are parsed', async () => {
  const types = await extract('surface.ts', `namespace App {
 interface Runner { run(): void; }
 type Result = string;
 enum State { Waiting, Ready }
 abstract class Worker { abstract run(): void; start = () => 1; }
}`);
  assert.equal(types.enumeration.complete, true);
  for (const kind of ['namespace', 'interface', 'type_alias', 'enum', 'class', 'method']) {
    assert.ok(types.entities.some(entity => entity.kind === kind), kind);
  }
  const tsx = await extract('surface.tsx', `import React, { useState as state } from 'react';
import * as api from './api';
export const Surface = () => {
 function reload() {}
 return <main><button onClick={reload}>Reload</button></main>;
};`);
  assert.equal(tsx.enumeration.complete, true);
  assert.ok(tsx.entities.some(entity => entity.qualifiedName === 'surface.tsx::Surface::reload'));
  assert.deepEqual(tsx.imports.map(item => item.bindings), [
    [{ imported: 'default', local: 'React' }, { imported: 'useState', local: 'state' }],
    [{ imported: '*', local: 'api' }],
  ]);
  assertForest(types); assertForest(tsx);
});

test('Python decorators, async methods, nested scopes, and import aliases are parsed without Python', async () => {
  const source = `from .memory import Context as State
import os.path, collections as bags
@registered
class Gateway:
    async def run(self):
        from .scheduler import start as launch
        def nested():
            pass
        return State()
class Session:
    def run(self):
        pass
`;
  const result = await extract('gateway.py', source);
  assert.equal(result.enumeration.complete, true);
  assert.ok(result.entities.some(entity => entity.qualifiedName === 'gateway.py::Gateway::run::nested'));
  assert.equal(result.entities.filter(entity => entity.label === 'run').length, 2);
  assert.deepEqual(result.imports.map(item => item.specifier), ['.memory', 'os.path', 'collections', '.scheduler']);
  assert.deepEqual(result.imports[1].bindings, [{ imported: '*', local: 'os' }]);
  assert.equal(result.imports[3].ownerId, result.entities.find(entity => entity.qualifiedName === 'gateway.py::Gateway::run').id);
  assert.ok(result.imports.every(item => item.resolved === false && !('target' in item)));
  assertForest(result);
});

test('import references remain references, including side effects, reexports, and dynamic imports', async () => {
  const result = await extract('app.mjs', `import './setup.js';
export { start as launch } from './worker.js';
async function run() { return import('./extra.js'); }
`);
  assert.equal(result.imports.length, 3);
  assert.deepEqual(result.imports.map(item => item.kind), ['import', 'reexport', 'dynamic_import']);
  assert.deepEqual(result.imports[1].bindings, [{ imported: 'start', local: 'launch' }]);
  assert.equal(result.entities.some(entity => entity.label.includes('setup')), false);
  assert.equal(result.relations.some(relation => relation.kind !== 'contains'), false);
});

test('TS import assignments are syntax imports while require calls need binding resolution', async () => {
  const types = await extract('tool.ts', 'import Tool = require("./tool"); export * as worker from "./worker";');
  assert.deepEqual(types.imports.map(item => item.specifier), ['./tool', './worker']);
  assert.deepEqual(types.imports.map(item => item.bindings), [[{ imported: '*', local: 'Tool' }], [{ imported: '*', local: 'worker' }]]);
  assert.equal(types.enumeration.complete, true);
  const common = await extract('tool.cjs', 'function run(require) { const tool = require("./tool"); }');
  assert.equal(common.imports[0].kind, 'require_reference');
  assert.equal(common.imports[0].resolved, false);
  assert.ok(common.enumeration.omissions.includes('require_resolution'));
  assert.equal(common.enumeration.complete, false);
});

test('syntax errors preserve valid siblings but cannot certify complete enumeration', async () => {
  const result = await extract('broken.js', 'class Good { run() {} }\nclass Broken { run( {\n');
  assert.equal(result.enumeration.complete, false);
  assert.ok(result.enumeration.omissions.includes('parse_error'));
  assert.deepEqual(result.enumeration.coveredRanges, []);
  assert.ok(result.entities.some(entity => entity.label === 'Good'));
  assert.equal(result.entities.some(entity => entity.label === 'Broken'), false);
  assertForest(result);
  const partial = await extract('partial.py', 'class Good:\n    pass\n', { complete: false });
  assert.equal(partial.enumeration.complete, false);
  assert.ok(partial.enumeration.omissions.includes('partial_capture'));
});

test('source, traversal, depth, entity, and import limits are visible and preserve a forest', async () => {
  const text = Array.from({ length: 20 }, (_, i) => `class C${i} { run() {} }`).join('\n');
  const limited = await extract('many.js', text, { limits: { entities: 4 } });
  assert.equal(limited.entities.length, 4);
  assert.ok(limited.enumeration.omissions.includes('entity_limit'));
  assert.equal(limited.enumeration.complete, false); assertForest(limited);
  for (const [limits, reason] of [[{ fileBytes: 10 }, 'file_bytes'], [{ nodes: 2 }, 'node_limit'], [{ depth: 1 }, 'depth_limit']]) {
    const result = await extract('many.js', text, { limits });
    assert.ok(result.enumeration.omissions.includes(reason), reason);
    assert.equal(result.enumeration.complete, false);
  }
  const imports = await extract('many.js', 'import "a"; import "b";', { limits: { imports: 1 } });
  assert.equal(imports.imports.length, 1);
  assert.ok(imports.enumeration.omissions.includes('import_limit'));
  const bindings = await extract('bindings.js', 'import { a,b,c } from "./mod";', { limits: { bindings: 2 } });
  assert.equal(bindings.imports[0].bindings.length, 2);
  assert.ok(bindings.enumeration.omissions.includes('binding_limit'));
});

test('anonymous scopes and binding patterns cannot create guessed parsed owners', async () => {
  const result = await extract('app.js', `items.map(() => { class Hidden { run() {} } });
const { nested } = object;
class Visible { run() {} }
function container() { return { hidden() {} }; }`);
  assert.equal(result.entities.some(entity => entity.label === 'Hidden'), false);
  assert.equal(result.entities.some(entity => entity.label === 'hidden'), false);
  assert.equal(result.enumeration.complete, false);
  assert.ok(result.enumeration.omissions.includes('anonymous_scope'));
  assert.ok(result.enumeration.omissions.includes('unsupported_declaration'));
  assertForest(result);
});

test('documentation fences and unsupported languages return only file-level capability', async () => {
  for (const relativePath of ['README.md', 'architecture.mdx', 'guide.rst', 'worker.go']) {
    const result = await extract(relativePath, '```javascript\nclass Misleading { run() {} }\n```');
    assert.equal(result.enumeration.capability, 'unsupported');
    assert.equal(result.enumeration.complete, false);
    assert.deepEqual(result.enumeration.omissions, ['unsupported_language']);
    assert.equal(result.entities.length, 1);
    assert.equal(result.relations.length, 0);
  }
});

test('filters, evidence mismatch, and cancellation never expose source declarations', async () => {
  const filtered = await extract('app.js', 'const password = "synthetic-only"; class Hidden {}');
  assert.deepEqual(filtered.enumeration.omissions, ['source_filtered']);
  assert.equal(filtered.entities.length, 1);
  const excluded = await extract('.env.js', 'class Hidden {}');
  assert.equal(excluded.entities.length, 0);
  const mismatch = await extract('app.js', 'class Hidden {}', { hash: hash('other') });
  assert.deepEqual(mismatch.enumeration.omissions, ['hash_mismatch']);
  const controller = new AbortController(); controller.abort();
  const cancelled = await extract('app.js', 'class Hidden {}', { signal: controller.signal });
  assert.deepEqual(cancelled.enumeration.omissions, ['aborted']);
  assert.equal(cancelled.entities.length, 1);
});

test('a large parse yields an explicit timeout within the source work budget', async () => {
  const text = 'function run() { return 1; }\n'.repeat(8000);
  const start = performance.now();
  const result = await extract('large.js', text, { limits: { milliseconds: 1 } });
  assert.equal(result.enumeration.complete, false);
  assert.ok(result.enumeration.omissions.some(reason => ['parse_timeout', 'extraction_timeout'].includes(reason)));
  assert.ok(performance.now() - start < 2000);
});

test('missing packaged parser fails open to labelled lexical file fallback', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'graphlin-parser-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Even an ancestor project's same-named dependency must never be a fallback.
  const fake = path.join(directory, 'node_modules/@vscode/tree-sitter-wasm');
  await mkdir(path.join(fake, 'wasm'), { recursive: true });
  await writeFile(path.join(fake, 'package.json'), JSON.stringify({
    name: '@vscode/tree-sitter-wasm', version: '0.3.1', main: 'wasm/tree-sitter.js',
  }));
  await writeFile(path.join(fake, 'wasm/tree-sitter.js'),
    'globalThis.graphlinProjectParserFixtureTouched = true; throw new Error("PROJECT_CODE_MUST_NOT_EXECUTE");');
  t.after(() => { delete globalThis.graphlinProjectParserFixtureTouched; });
  const runtime = path.join(directory, 'plugin/runtime');
  for (const file of ['discovery/structure.mjs', 'discovery/parser.mjs', 'core/common.mjs', 'core/privacy.mjs', 'core/tool-discovery.mjs']) {
    await mkdir(path.dirname(path.join(runtime, file)), { recursive: true });
    await cp(fileURLToPath(new URL(`../../runtime/${file}`, import.meta.url)), path.join(runtime, file));
  }
  const { extractStructure: isolated } = await import(pathToFileURL(path.join(runtime, 'discovery/structure.mjs')).href);
  const text = 'class Gateway { run() {} }';
  const result = await isolated({ artifactId: opaque('artifact', 'fixture'), relativePath: 'fixture.js', text, hash: hash(text), generation: 1 });
  assert.equal(result.enumeration.capability, 'lexical');
  assert.deepEqual(result.enumeration.omissions, ['parser_unavailable']);
  assert.equal(result.entities.length, 1);
  assert.equal(globalThis.graphlinProjectParserFixtureTouched, undefined);
});

test('runtime dependency resolves independently of a project cwd or project parser', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'graphlin-project-parser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = path.join(directory, 'node_modules/@vscode/tree-sitter-wasm');
  await mkdir(fake, { recursive: true });
  await writeFile(path.join(fake, 'package.json'), JSON.stringify({ main: 'index.js' }));
  await writeFile(path.join(fake, 'index.js'), 'throw new Error("PROJECT_CODE_MUST_NOT_EXECUTE");');
  const moduleUrl = new URL('../../runtime/discovery/index.mjs', import.meta.url).href;
  const source = `import {extractStructure} from ${JSON.stringify(moduleUrl)};
import {createHash} from 'node:crypto';
const text='class Gateway {}';
const result=await extractStructure({artifactId:'artifact-123456789012345678901234',relativePath:'app.js',text,hash:createHash('sha256').update(text).digest('hex'),generation:1});
console.log(result.enumeration.capability);`;
  const result = await run(process.execPath, ['--input-type=module', '-e', source], { cwd: directory });
  assert.equal(result.stdout.trim(), 'parsed');
});
