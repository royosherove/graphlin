import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInventory } from '../../runtime/discovery/index.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'graphlin-inventory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function file(relativePath, contents = 'synthetic fixture only') {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    return target;
  }
  return { directory, file };
}
async function drain(inventory, options = {}) {
  const pages = [];
  for (let i = 0; i < 2000; i++) {
    const page = await inventory.next(options);
    pages.push(page);
    if (!page.continuation) return pages;
  }
  throw new Error('inventory did not terminate');
}

test('inventory uses metadata only, without content reads or hashes', async t => {
  const { directory, file } = await fixture(t);
  await file('src/gateway.py', 'class Gateway: pass');
  const target = await file('src/unreadable.py');
  await chmod(target, 0o000);
  const inventory = createInventory({ projectRoot: directory });
  t.after(() => inventory.close());
  for (const [object, method] of [[fsPromises, 'readFile'], [fsPromises, 'open'], [fs, 'readFileSync'], [fs, 'openSync']]) {
    t.mock.method(object, method, () => { throw new Error('SOURCE_READ_FORBIDDEN'); });
  }
  const pages = await drain(inventory);
  assert.equal(pages.at(-1).coverage.complete, true);
  const entries = pages.flatMap(page => page.entries);
  assert.deepEqual(entries.map(entry => entry.relativePath).sort(), ['src', 'src/gateway.py', 'src/unreadable.py']);
  assert.ok(entries.every(entry => Object.keys(entry).sort().join(',') === 'kind,mtimeMs,relativePath,root,size'));
  assert.ok(pages.flatMap(page => page.paths).every(relativePath => relativePath.endsWith('.py')));
});

test('excluded and symlink paths are not followed or projected', async t => {
  const { directory, file } = await fixture(t);
  await file('src/main.ts');
  await file('node_modules/vendor.js');
  await file('.graphlin-local/state.json');
  await file('.env');
  await file('private/hidden.py');
  await file('generated/output.js');
  await file('secret-material.js');
  await symlink(path.join(directory, 'private'), path.join(directory, 'alias'));
  await symlink(path.join(directory, 'src/main.ts'), path.join(directory, 'main-link.ts'));
  const inventory = createInventory({ projectRoot: directory, excludePaths: ['private/**', 'generated'] });
  t.after(() => inventory.close());
  const pages = await drain(inventory);
  assert.deepEqual(pages.flatMap(page => page.entries).map(entry => entry.relativePath).sort(), ['src', 'src/main.ts']);
  assert.equal(pages.at(-1).coverage.symlinks, 2);
  assert.ok(pages.at(-1).coverage.excluded >= 8);
  assert.equal(pages.at(-1).coverage.complete, true);
});

test('continuations progress beyond 64 files and serve multiple application roots fairly', async t => {
  const { directory, file } = await fixture(t);
  for (let i = 0; i < 160; i++) await file(`00-tooling/task-${i}.py`);
  for (const root of ['gateway', 'web', 'sessions', 'memory', 'scheduler']) await file(`${root}/src/entry.${root === 'web' ? 'tsx' : 'py'}`);
  const inventory = createInventory({ projectRoot: directory });
  t.after(() => inventory.close());
  const pages = await drain(inventory, { limit: 16 });
  assert.ok(pages.length > 4);
  const entries = pages.flatMap(page => page.entries);
  assert.equal(new Set(entries.map(entry => entry.relativePath)).size, entries.length);
  assert.equal(pages.flatMap(page => page.paths).length, 165);
  for (const root of ['gateway', 'web', 'sessions', 'memory', 'scheduler']) {
    const position = entries.findIndex(entry => entry.kind === 'file' && entry.root === root);
    assert.ok(position >= 0 && position < 64, `${root} reached at ${position}`);
  }
  assert.equal(pages.at(-1).coverage.complete, true);
});

test('root-level tooling ahead of source roots resumes until the source roots are reached', async t => {
  const { directory, file } = await fixture(t);
  for (let i = 0; i < 100; i++) await file(`00-tool-${i}.js`);
  await file('python/src/gateway.py');
  await file('web/src/surface.tsx');
  const inventory = createInventory({ projectRoot: directory });
  t.after(() => inventory.close());
  const pages = await drain(inventory, { limit: 8 });
  assert.ok(pages.length > 8);
  const paths = pages.flatMap(page => page.paths);
  assert.equal(paths.length, 102);
  assert.ok(paths.includes('python/src/gateway.py'));
  assert.ok(paths.includes('web/src/surface.tsx'));
  assert.equal(pages.at(-1).coverage.complete, true);
});

test('entry slices and cancellation preserve resumable traversal', async t => {
  const { directory, file } = await fixture(t);
  for (let i = 0; i < 20; i++) await file(`source-${i}.js`);
  const inventory = createInventory({ projectRoot: directory, limits: { entriesPerSlice: 3 } });
  t.after(() => inventory.close());
  const controller = new AbortController(); controller.abort();
  const aborted = await inventory.next({ signal: controller.signal });
  assert.equal(aborted.coverage.visited, 0);
  assert.ok(aborted.coverage.omissions.includes('aborted'));
  assert.ok(aborted.continuation);
  const pages = await drain(inventory);
  assert.ok(pages[0].coverage.omissions.includes('entry_limit'));
  assert.equal(pages.flatMap(page => page.paths).length, 20);
  assert.equal(pages.at(-1).coverage.complete, true);
  const exhausted = await inventory.next();
  assert.deepEqual(exhausted.entries, []);
  assert.equal(exhausted.continuation, null);
});

test('path, directory, and depth caps report uncertainty rather than absence', async t => {
  const { directory, file } = await fixture(t);
  for (let i = 0; i < 10; i++) await file(`area-${i}/nested/deep/main.js`);
  for (const [limits, reason] of [[{ paths: 3 }, 'path_limit'], [{ directories: 2 }, 'directory_limit'], [{ depth: 1 }, 'depth_limit']]) {
    const inventory = createInventory({ projectRoot: directory, limits });
    const pages = await drain(inventory);
    assert.equal(pages.at(-1).coverage.complete, false);
    assert.ok(pages.at(-1).coverage.omissions.includes(reason), reason);
    assert.ok(pages.at(-1).coverage.deferred > 0, reason);
    await inventory.close();
  }
});

test('replacement of the canonical root cannot enumerate a symlink target', async t => {
  const { directory, file } = await fixture(t);
  await file('project/one.js');
  await file('project/two.js');
  await file('outside/hidden.js');
  const projectRoot = path.join(directory, 'project');
  const inventory = createInventory({ projectRoot });
  t.after(() => inventory.close());
  await inventory.next({ limit: 1 });
  await rename(projectRoot, path.join(directory, 'original'));
  await symlink(path.join(directory, 'outside'), projectRoot);
  const pages = await drain(inventory);
  assert.equal(pages.flatMap(page => page.entries).length, 0);
  assert.equal(pages.at(-1).coverage.complete, false);
  assert.ok(pages.at(-1).coverage.omissions.includes('unavailable'));
});

test('canonical root aliases work and abandoned cursors close explicitly', async t => {
  const { directory, file } = await fixture(t);
  await file('project/one.js');
  await file('project/two.js');
  await symlink(path.join(directory, 'project'), path.join(directory, 'project-alias'));
  const inventory = createInventory({ projectRoot: path.join(directory, 'project-alias') });
  const page = await inventory.next({ limit: 1 });
  assert.equal(page.entries.length, 1);
  await inventory.close();
  const closed = await inventory.next();
  assert.equal(closed.continuation, null);
  assert.equal(closed.coverage.complete, false);
  assert.ok(closed.coverage.omissions.includes('closed'));
});
