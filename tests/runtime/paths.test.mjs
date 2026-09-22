import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, lstat, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers.mjs';
import { projectPaths, defaultDataDir, hash, atomicJSON } from '../../runtime/daemon/paths.mjs';
import { daemonStatus } from '../../runtime/daemon/manager.mjs';
import { collect } from '../../runtime/collector/index.mjs';
import { readSettings, saveSettings } from '../../runtime/daemon/settings.mjs';
import { runExtensions } from '../../scripts/extensions.mjs';

const execute = promisify(execFile);
const missing = filename => assert.rejects(lstat(filename), { code: 'ENOENT' });
function override(t, value) {
  const previous = process.env.GRAPHLIN_DATA_DIR;
  if (value === undefined) delete process.env.GRAPHLIN_DATA_DIR;
  else process.env.GRAPHLIN_DATA_DIR = value;
  t.after(() => {
    if (previous === undefined) delete process.env.GRAPHLIN_DATA_DIR;
    else process.env.GRAPHLIN_DATA_DIR = previous;
  });
}
async function git(root, ...args) {
  return execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.excludesFile=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', ...args], {
    cwd: root, timeout: 5000, maxBuffer: 32 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

test('default storage resolves after the Git root, including nested cwd and root aliases', async t => {
  override(t);
  const { base, projectRoot } = await workspace(t);
  await mkdir(path.join(projectRoot, '.git'));
  const nested = path.join(projectRoot, 'src', 'nested'), alias = path.join(base, 'alias');
  await mkdir(nested, { recursive: true });
  await symlink(projectRoot, alias);
  const direct = await projectPaths(projectRoot);
  for (const input of [nested, path.join(alias, 'src', 'nested')]) {
    assert.deepEqual(await projectPaths(input), direct);
  }
  assert.equal(direct.dataDir, path.join(projectRoot, '.graphlin'));
  assert.equal(direct.directory, path.join(direct.dataDir, hash(projectRoot)));
  assert.equal(defaultDataDir(projectRoot), direct.dataDir);
  assert.equal(defaultDataDir(), path.join(process.cwd(), '.graphlin'));
  assert.ok(direct.socket.startsWith('/tmp/graphlin-'));
  assert.ok(direct.socket.length < 100);
  await missing(direct.dataDir);
  await missing(path.join(projectRoot, '.gitignore'));
});

test('worktree .git files keep each worktree storage and project identity separate', async t => {
  override(t);
  const { base, projectRoot } = await workspace(t);
  const worktree = path.join(base, 'worktree');
  await mkdir(path.join(projectRoot, '.git'));
  await mkdir(path.join(worktree, 'nested'), { recursive: true });
  await writeFile(path.join(worktree, '.git'), 'gitdir: /synthetic/worktree-metadata\n');
  const main = await projectPaths(projectRoot, undefined, { create: true });
  const other = await projectPaths(path.join(worktree, 'nested'), undefined, { create: true });
  assert.equal(other.projectRoot, worktree);
  assert.equal(other.dataDir, path.join(worktree, '.graphlin'));
  assert.notEqual(main.projectId, other.projectId);
  assert.notEqual(main.socket, other.socket);
  assert.equal(await readFile(path.join(worktree, '.git'), 'utf8'), 'gitdir: /synthetic/worktree-metadata\n');
  assert.equal(await readFile(path.join(worktree, '.gitignore'), 'utf8'), '/.graphlin/\n');
});

test('path resolution, status, settings reads and passive hooks create no artifacts', async t => {
  override(t);
  const { projectRoot } = await workspace(t);
  await mkdir(path.join(projectRoot, '.git'));
  await writeFile(path.join(projectRoot, '.gitignore'), '# Leave this unchanged');
  const before = await readdir(projectRoot);
  const paths = await projectPaths(projectRoot);
  assert.equal((await daemonStatus({ projectRoot })).running, false);
  assert.deepEqual(await readSettings({ projectRoot }), {});
  assert.equal(await collect({ cwd: projectRoot, hook_event_name: 'SessionStart' }, { timeoutMs: 50 }), false);
  assert.deepEqual(await readdir(projectRoot), before);
  assert.equal(await readFile(path.join(projectRoot, '.gitignore'), 'utf8'), '# Leave this unchanged');
  await missing(paths.dataDir);
  await missing(paths.socket);
});

test('explicit data directory wins over the environment; outside overrides do not change repository ignores', async t => {
  const { base, projectRoot, dataDir } = await workspace(t);
  override(t, dataDir);
  await mkdir(path.join(projectRoot, '.git'));
  assert.equal((await projectPaths(projectRoot)).dataDir, dataDir);
  const explicit = path.join(base, 'explicit');
  assert.equal((await projectPaths(projectRoot, explicit, { create: true })).dataDir, explicit);
  assert.equal(defaultDataDir(projectRoot), dataDir);
  await missing(path.join(projectRoot, '.graphlin'));
  await missing(path.join(projectRoot, '.gitignore'));
});

test('explicit and environment-selected repository .graphlin paths receive the same ignore protection', async t => {
  for (const kind of ['explicit', 'environment', 'root alias']) await t.test(kind, async t => {
    const { base, projectRoot } = await workspace(t);
    await mkdir(path.join(projectRoot, '.git'));
    const local = path.join(projectRoot, '.graphlin');
    override(t, kind === 'environment' ? local : undefined);
    let requested = kind === 'environment' ? undefined : local;
    if (kind === 'root alias') {
      const alias = path.join(base, 'alias');
      await symlink(projectRoot, alias);
      requested = path.join(alias, '.graphlin');
    }
    const paths = await projectPaths(projectRoot, requested, { create: true });
    assert.equal(paths.dataDir, local);
    assert.equal(await readFile(path.join(projectRoot, '.gitignore'), 'utf8'), '/.graphlin/\n');
    assert.equal(await readFile(path.join(local, '.gitignore'), 'utf8'), '*\n');
    assert.equal((await lstat(local)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.directory)).mode & 0o777, 0o700);
  });
});

test('ignore setup appends only, preserves newline style, and is idempotent', async t => {
  const samples = [
    ['', '/.graphlin/\n'],
    ['# Keep\nnode_modules/\n', '# Keep\nnode_modules/\n/.graphlin/\n'],
    ['# Keep\r\nnode_modules/\r\n', '# Keep\r\nnode_modules/\r\n/.graphlin/\r\n'],
    ['# Keep\nnode_modules/', '# Keep\nnode_modules/\n/.graphlin/\n'],
    ['/.graphlin/\nnode_modules/\n', '/.graphlin/\nnode_modules/\n'],
    ['/.graphlin/\n!/.graphlin/\n', '/.graphlin/\n!/.graphlin/\n/.graphlin/\n'],
  ];
  for (const [before, expected] of samples) await t.test(JSON.stringify(before), async t => {
    override(t);
    const { projectRoot } = await workspace(t);
    await mkdir(path.join(projectRoot, '.git'));
    const ignore = path.join(projectRoot, '.gitignore');
    await writeFile(ignore, before, { mode: 0o644 });
    const original = await lstat(ignore);
    const paths = await projectPaths(projectRoot, undefined, { create: true });
    await projectPaths(projectRoot, paths.dataDir, { create: true });
    assert.equal(await readFile(ignore, 'utf8'), expected);
    const after = await lstat(ignore);
    assert.equal(after.ino, original.ino, 'an existing ignore file is never replaced');
    assert.equal(after.mode, original.mode, 'existing permissions are preserved');
    assert.equal(await readFile(path.join(paths.dataDir, '.gitignore'), 'utf8'), '*\n');
  });
});

test('concurrent storage preparation succeeds and repeated setup remains idempotent', async t => {
  override(t);
  const { projectRoot } = await workspace(t);
  await mkdir(path.join(projectRoot, '.git'));
  const paths = await Promise.all(Array.from({ length: 8 }, () =>
    projectPaths(projectRoot, undefined, { create: true })));
  assert.ok(paths.every(value => value.dataDir === paths[0].dataDir));
  assert.equal(await readFile(path.join(projectRoot, '.gitignore'), 'utf8'), '/.graphlin/\n');
  assert.equal(await readFile(path.join(paths[0].dataDir, '.gitignore'), 'utf8'), '*\n');
});

test('independent starters tolerate concurrent ignore appends without overwriting existing rules', async t => {
  override(t);
  const { projectRoot } = await workspace(t);
  await mkdir(path.join(projectRoot, '.git'));
  await writeFile(path.join(projectRoot, '.gitignore'), '# Keep\nnode_modules/\n');
  const source = `import { projectPaths } from ${JSON.stringify(new URL('../../runtime/daemon/paths.mjs', import.meta.url).href)};
    await projectPaths(process.argv[1], process.argv[2], { create: true });`;
  await Promise.all(Array.from({ length: 6 }, () => execute(process.execPath,
    ['--input-type=module', '-e', source, projectRoot, path.join(projectRoot, '.graphlin')], {
      timeout: 5000, maxBuffer: 4096, env: { PATH: process.env.PATH },
    })));
  const ignore = await readFile(path.join(projectRoot, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('# Keep\nnode_modules/\n'));
  assert.ok(ignore.endsWith('/.graphlin/\n'));
  await projectPaths(projectRoot, undefined, { create: true });
  assert.equal(await readFile(path.join(projectRoot, '.gitignore'), 'utf8'), ignore);
});

test('Git ignores sensitive base and project files before settings can be written', async t => {
  override(t);
  const { projectRoot } = await workspace(t);
  await git(projectRoot, 'init', '--quiet');
  await writeFile(path.join(projectRoot, '.gitignore'), '/.graphlin/\n!/.graphlin/\n!/.graphlin/settings.json\n');
  await saveSettings({ projectRoot }, { apiKey: 'SYNTHETIC_ONLY', policy: {
    allowSource: false, localSource: true, persistEvidence: false, displayEvidence: true,
  } });
  const paths = await projectPaths(projectRoot);
  const names = ['.graphlin/settings.json', `.graphlin/${paths.projectId}/settings.json`, '.graphlin/.gitignore'];
  const ignored = await git(projectRoot, 'check-ignore', '--no-index', ...names);
  assert.deepEqual(ignored.stdout.trim().split('\n'), names);
  const status = await git(projectRoot, 'status', '--porcelain', '--untracked-files=all');
  assert.doesNotMatch(status.stdout, /\.graphlin\//);
  assert.deepEqual(await readSettings({ projectRoot }), {
    apiKey: 'SYNTHETIC_ONLY', policy: {
      allowSource: false, localSource: true, persistEvidence: false, displayEvidence: true,
    },
  });
});

test('standalone storage self-ignores even when the project becomes a repository later', async t => {
  override(t);
  const { projectRoot } = await workspace(t);
  const paths = await projectPaths(projectRoot, undefined, { create: true });
  await missing(path.join(projectRoot, '.gitignore'));
  await atomicJSON(path.join(paths.dataDir, 'settings.json'), { synthetic: true });
  await git(projectRoot, 'init', '--quiet');
  const ignored = await git(projectRoot, 'check-ignore', '--no-index', '.graphlin/settings.json', '.graphlin/.gitignore');
  assert.equal(ignored.stdout, '.graphlin/settings.json\n.graphlin/.gitignore\n');
});

test('default .graphlin symlinks are refused during read-only resolution, including dangling links', async t => {
  for (const exists of [false, true]) await t.test(String(exists), async t => {
    override(t);
    const { base, projectRoot } = await workspace(t);
    await mkdir(path.join(projectRoot, '.git'));
    const destination = path.join(base, 'target');
    if (exists) await mkdir(destination);
    await symlink(destination, path.join(projectRoot, '.graphlin'));
    for (const create of [false, true]) {
      await assert.rejects(projectPaths(projectRoot, undefined, { create }), { code: 'unsafe_data_directory' });
      await assert.rejects(projectPaths(projectRoot, path.join(projectRoot, '.graphlin'), { create }),
        { code: 'unsafe_data_directory' });
    }
    await missing(path.join(projectRoot, '.gitignore'));
    if (exists) assert.deepEqual(await readdir(destination), []);
  });
});

test('unsafe root or self-ignore paths block storage without altering their targets', async t => {
  for (const location of ['root', 'self']) for (const kind of ['symlink', 'hardlink', 'directory']) {
    await t.test(`${location} ${kind}`, async t => {
      override(t);
      const { base, projectRoot } = await workspace(t);
      await mkdir(path.join(projectRoot, '.git'));
      const local = path.join(projectRoot, '.graphlin');
      if (location === 'self') await mkdir(local, { mode: 0o700 });
      const ignore = path.join(location === 'root' ? projectRoot : local, '.gitignore');
      const target = path.join(base, 'untouched');
      await writeFile(target, 'Do not modify\n');
      if (kind === 'directory') await mkdir(ignore);
      else if (kind === 'symlink') await symlink(target, ignore);
      else await link(target, ignore);
      await assert.rejects(saveSettings({ projectRoot }, { apiKey: 'SYNTHETIC_ONLY' }), { code: 'unsafe_ignore_file' });
      assert.equal(await readFile(target, 'utf8'), 'Do not modify\n');
      await missing(path.join(local, 'settings.json'));
      await missing(path.join(local, hash(projectRoot)));
      if (location === 'root') await missing(local);
    });
  }
});

test('extensions initialize protected repository storage instead of a home default', async t => {
  override(t);
  const { projectRoot } = await workspace(t);
  await mkdir(path.join(projectRoot, '.git'));
  const nested = path.join(projectRoot, 'nested');
  await mkdir(nested);
  assert.deepEqual(await runExtensions(['list'], { projectRoot: nested, output: null }), []);
  const paths = await projectPaths(projectRoot);
  assert.equal(await readFile(path.join(projectRoot, '.gitignore'), 'utf8'), '/.graphlin/\n');
  assert.equal(await readFile(path.join(paths.dataDir, '.gitignore'), 'utf8'), '*\n');
  assert.ok((await lstat(path.join(paths.dataDir, 'extensions'))).isDirectory());
  await missing(path.join(nested, '.graphlin'));
});
