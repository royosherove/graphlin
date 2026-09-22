import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers.mjs';
import { projectPaths, hash } from '../../runtime/daemon/paths.mjs';
import { saveSettings } from '../../runtime/daemon/settings.mjs';

const execute = promisify(execFile);
const missing = filename => assert.rejects(lstat(filename), { code: 'ENOENT' });
const gitEnv = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const moduleURL = name => new URL(`../../${name}`, import.meta.url).href;
async function git(root, ...args) {
  return execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'init.templateDir=', ...args], { cwd: root, timeout: 5000, maxBuffer: 64 * 1024, env: gitEnv() });
}
async function saveInChild(projectRoot, searchPath, extraEnv = {}) {
  const source = `import { saveSettings } from ${JSON.stringify(moduleURL('runtime/daemon/settings.mjs'))};
    try {
      await saveSettings({ projectRoot: process.argv[1] }, { apiKey: 'SYNTHETIC_ONLY' });
      console.log('ok');
    } catch (error) { console.log(error.code); }`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', source, projectRoot], {
    timeout: 6000, maxBuffer: 4096, env: { PATH: searchPath, ...extraEnv },
  });
  assert.equal(result.stderr, '');
  return result.stdout.trim();
}
async function fakeGit(base, body) {
  const directory = path.join(base, 'tools');
  await mkdir(directory);
  await writeFile(path.join(directory, 'git'), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return directory;
}

test('tracked local state blocks settings before any secret, ignore, or index change', async t => {
  for (const kind of ['base settings', 'project state', 'protective ignore', 'deleted destination']) {
    await t.test(kind, async t => {
      const { projectRoot } = await workspace(t);
      await git(projectRoot, 'init', '--quiet');
      const local = path.join(projectRoot, '.graphlin');
      const relative = kind === 'project state' ? `${hash(projectRoot)}/state.json` :
        kind === 'protective ignore' ? '.gitignore' : 'settings.json';
      const filename = path.join(local, relative);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const original = kind === 'protective ignore' ? '*\n' : '{"schemaVersion":1}\n';
      await writeFile(filename, original, { mode: 0o600 });
      await writeFile(path.join(projectRoot, '.gitignore'), '# Preserve\r\n/.graphlin/\r\n');
      await git(projectRoot, 'add', '-f', '--', `.graphlin/${relative}`);
      const index = await readFile(path.join(projectRoot, '.git', 'index'));
      if (kind === 'deleted destination') await rm(local, { recursive: true });
      await assert.rejects(saveSettings({ projectRoot, dataDir: local }, { apiKey: 'SYNTHETIC_ONLY' }),
        { code: 'tracked_state_directory', message: 'tracked_state_directory' });
      assert.equal(await readFile(path.join(projectRoot, '.gitignore'), 'utf8'), '# Preserve\r\n/.graphlin/\r\n');
      assert.deepEqual(await readFile(path.join(projectRoot, '.git', 'index')), index);
      if (kind === 'deleted destination') await missing(local);
      else {
        assert.equal(await readFile(filename, 'utf8'), original);
        if (relative !== 'settings.json') await missing(path.join(local, 'settings.json'));
        // A normal add -u cannot stage a secret because storage refused to write it.
        await git(projectRoot, 'add', '-u', '--', '.graphlin');
        assert.equal((await git(projectRoot, 'show', `:.graphlin/${relative}`)).stdout, original);
      }
    });
  }
});

test('every write rechecks the index and an unrelated tracked file does not block storage', async t => {
  const { projectRoot } = await workspace(t);
  await git(projectRoot, 'init', '--quiet');
  await writeFile(path.join(projectRoot, 'public.txt'), 'public fixture\n');
  await git(projectRoot, 'add', '--', 'public.txt');
  const local = path.join(projectRoot, '.graphlin'), context = { projectRoot, dataDir: local };
  await saveSettings(context, { apiKey: 'SYNTHETIC_FIRST' });
  await git(projectRoot, 'add', '-f', '--', '.graphlin/settings.json');
  const before = await readFile(path.join(local, 'settings.json'));
  await assert.rejects(saveSettings(context, { apiKey: 'SYNTHETIC_SECOND' }), { code: 'tracked_state_directory' });
  assert.deepEqual(await readFile(path.join(local, 'settings.json')), before);
});

test('Git directory pointers check the actual index with and without the Git executable', async t => {
  for (const relative of [false, true]) await t.test(relative ? 'relative pointer' : 'absolute pointer', async t => {
    const { base, projectRoot } = await workspace(t);
    const metadata = path.join(base, 'worktree metadata');
    await git(projectRoot, 'init', '--quiet', `--separate-git-dir=${metadata}`);
    if (relative) await writeFile(path.join(projectRoot, '.git'), 'gitdir: ../worktree metadata\n');
    const local = path.join(projectRoot, '.graphlin');
    await mkdir(local, { mode: 0o700 });
    await writeFile(path.join(local, 'settings.json'), '{"schemaVersion":1}\n', { mode: 0o600 });
    await git(projectRoot, 'add', '--', '.graphlin/settings.json');
    const index = await readFile(path.join(metadata, 'index'));
    await assert.rejects(projectPaths(projectRoot, local, { create: true }), { code: 'tracked_state_directory' });
    const noGit = path.join(base, 'empty-path');
    await mkdir(noGit);
    assert.equal(await saveInChild(projectRoot, noGit), 'tracked_state_directory');
    assert.deepEqual(await readFile(path.join(metadata, 'index')), index);
    assert.equal(await readFile(path.join(local, 'settings.json'), 'utf8'), '{"schemaVersion":1}\n');
    await missing(path.join(projectRoot, '.gitignore'));
  });
});

test('missing Git permits standalone and minimal demo boundaries only when no index exists', async t => {
  for (const kind of ['standalone', 'minimal directory', 'minimal pointer', 'initialized Git', 'existing index', 'bad pointer']) {
    await t.test(kind, async t => {
      const { base, projectRoot } = await workspace(t);
      if (kind === 'initialized Git' || kind === 'existing index') {
        await git(projectRoot, 'init', '--quiet');
        if (kind === 'existing index') {
          await writeFile(path.join(projectRoot, 'public.txt'), 'public\n');
          await git(projectRoot, 'add', '--', 'public.txt');
        }
      } else if (kind === 'minimal directory') await mkdir(path.join(projectRoot, '.git'));
      else if (kind === 'minimal pointer') {
        await mkdir(path.join(base, 'metadata'));
        await writeFile(path.join(projectRoot, '.git'), 'gitdir: ../metadata\n');
      } else if (kind === 'bad pointer') await writeFile(path.join(projectRoot, '.git'), 'not a gitdir pointer\n');
      const noGit = path.join(base, 'empty-path');
      await mkdir(noGit);
      const blocked = kind === 'existing index' || kind === 'bad pointer';
      assert.equal(await saveInChild(projectRoot, noGit), blocked ? 'tracked_state_directory' : 'ok');
      const local = path.join(projectRoot, '.graphlin');
      if (blocked) {
        await missing(local);
        await missing(path.join(projectRoot, '.gitignore'));
      } else {
        assert.equal(JSON.parse(await readFile(path.join(local, 'settings.json'), 'utf8')).apiKey, 'SYNTHETIC_ONLY');
        assert.equal(await readFile(path.join(local, '.gitignore'), 'utf8'), '*\n');
      }
    });
  }
});

test('a failed, timed-out or oversized Git check refuses an existing index with a fixed safe error', async t => {
  const bodies = [
    "process.stderr.write('synthetic raw failure must not escape'); process.exit(1);",
    'setInterval(() => {}, 1000);',
    "process.stdout.write('x'.repeat(128 * 1024));",
  ];
  for (const [index, body] of bodies.entries()) await t.test(['failure', 'timeout', 'output limit'][index], async t => {
    const { base, projectRoot } = await workspace(t);
    await git(projectRoot, 'init', '--quiet');
    await writeFile(path.join(projectRoot, 'public.txt'), 'public\n');
    await git(projectRoot, 'add', '--', 'public.txt');
    const searchPath = await fakeGit(base, body);
    assert.equal(await saveInChild(projectRoot, searchPath), 'tracked_state_directory');
    await missing(path.join(projectRoot, '.graphlin'));
    await missing(path.join(projectRoot, '.gitignore'));
  });
});

test('caller Git environment cannot redirect the tracked-state check to an empty index', async t => {
  const { base, projectRoot } = await workspace(t);
  await git(projectRoot, 'init', '--quiet');
  await mkdir(path.join(projectRoot, '.graphlin'));
  await writeFile(path.join(projectRoot, '.graphlin', 'settings.json'), '{"schemaVersion":1}\n');
  await git(projectRoot, 'add', '--', '.graphlin/settings.json');
  const other = path.join(base, 'other repo');
  await mkdir(other);
  await git(other, 'init', '--quiet');
  assert.equal(await saveInChild(projectRoot, process.env.PATH, {
    GIT_INDEX_FILE: path.join(base, 'absent-index'), GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other,
  }), 'tracked_state_directory');
  assert.equal(await readFile(path.join(projectRoot, '.graphlin', 'settings.json'), 'utf8'), '{"schemaVersion":1}\n');
  await missing(path.join(projectRoot, '.gitignore'));
});

test('read-only paths, status, settings and hooks never invoke Git or create ignore files', async t => {
  const { base, projectRoot } = await workspace(t);
  await git(projectRoot, 'init', '--quiet');
  await writeFile(path.join(projectRoot, 'public.txt'), 'public\n');
  await git(projectRoot, 'add', '--', 'public.txt');
  const marker = path.join(base, 'git-invoked');
  const searchPath = await fakeGit(base, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);`);
  const source = `import { projectPaths } from ${JSON.stringify(moduleURL('runtime/daemon/paths.mjs'))};
    import { daemonStatus } from ${JSON.stringify(moduleURL('runtime/daemon/manager.mjs'))};
    import { readSettings } from ${JSON.stringify(moduleURL('runtime/daemon/settings.mjs'))};
    import { collect } from ${JSON.stringify(moduleURL('runtime/collector/index.mjs'))};
    const projectRoot = process.argv[1];
    await projectPaths(projectRoot);
    await daemonStatus({ projectRoot });
    await readSettings({ projectRoot });
    await collect({ cwd: projectRoot, hook_event_name: 'SessionStart' }, { timeoutMs: 50 });`;
  await execute(process.execPath, ['--input-type=module', '-e', source, projectRoot], {
    timeout: 5000, maxBuffer: 4096, env: { PATH: searchPath },
  });
  await missing(marker);
  await missing(path.join(projectRoot, '.gitignore'));
  await missing(path.join(projectRoot, '.graphlin'));
});
