import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLineageReader } from '../../runtime/daemon/lineage.mjs';

const projectRoot = '/fixture/project with spaces';
const projectId = 'project-synthetic';
const head = 'a'.repeat(40);
function executor({ branch = 'feature/synthetic', commit = head, error, stderr = '' } = {}) {
  return (_file, args, _options, callback) => {
    if (error) return callback(error, '', stderr);
    if (args.includes('symbolic-ref') && branch === null) return callback({ code: 1 }, '', '');
    callback(null, `${args.includes('symbolic-ref') ? branch : commit}\n`, 'IGNORED_SYNTHETIC_STDERR');
  };
}
const reader = execute => createLineageReader({ projectRoot, projectId, execute });

test('branch and HEAD use bounded local Git with a fixed credential-free environment', async () => {
  const calls = [];
  const read = reader((file, args, options, callback) => {
    calls.push(args);
    assert.equal(file, 'git');
    assert.deepEqual(args.slice(0, 4), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']);
    assert.deepEqual(options, {
      cwd: projectRoot, shell: false, timeout: 0, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8',
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
    });
    executor()(file, args, options, callback);
  });
  const value = await read();
  assert.deepEqual(value, { id: value.id, status: 'git', branch: 'feature/synthetic', head });
  assert.match(value.id, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(calls.map(args => args.slice(4)), [
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['rev-parse', '--verify', '--end-of-options', 'HEAD'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  ]);
});

test('identities are stable and distinguish branch, HEAD, detached state and project', async () => {
  const base = await reader(executor())();
  assert.deepEqual(await reader(executor())(), base);
  for (const execute of [executor({ branch: 'other' }), executor({ commit: 'b'.repeat(40) }), executor({ branch: null })]) {
    assert.notEqual((await reader(execute)()).id, base.id);
  }
  const other = createLineageReader({ projectRoot, projectId: 'another-project', execute: executor() });
  assert.notEqual((await other()).id, base.id);
  const detached = await reader(executor({ branch: null, commit: 'c'.repeat(64) }))();
  assert.deepEqual(detached, { id: detached.id, status: 'git', head: 'c'.repeat(64) });
});

test('initial failures, unborn HEAD and unsafe output return stable unknown identities without details', async () => {
  const unavailable = await reader(executor({ error: { code: 'ENOENT', message: 'SYNTHETIC_PRIVATE' } }))();
  for (const execute of [
    () => { throw new Error('SYNTHETIC_PRIVATE'); },
    executor({ error: { code: 128 }, stderr: 'fatal: Needed a single revision SYNTHETIC_PRIVATE' }),
    executor({ error: { code: 1, killed: true } }),
    executor({ branch: 'bad\nSYNTHETIC_PRIVATE' }),
    executor({ branch: 'bad\u202eSYNTHETIC_PRIVATE' }),
    executor({ branch: '<script>' }),
    executor({ branch: '/Users/synthetic/private' }),
    executor({ branch: 'x'.repeat(241) }),
    executor({ commit: 'a'.repeat(39) }),
    executor({ commit: `${head}\nSYNTHETIC_PRIVATE` }),
    executor({ commit: 'A'.repeat(40) }),
  ]) assert.deepEqual(await reader(execute)(), unavailable);
  assert.deepEqual(Object.keys(unavailable), ['id', 'status']);
  assert.equal(unavailable.status, 'unknown');
  const notGit = await reader(executor({ error: { code: 128 },
    stderr: 'fatal: not a git repository (or any of the parent directories): .git SYNTHETIC_PRIVATE' }))();
  assert.equal(notGit.status, 'not_git');
  assert.notEqual(notGit.id, unavailable.id);
  assert.doesNotMatch(JSON.stringify([unavailable, notGit]), /SYNTHETIC_PRIVATE|fixture/);
});

test('two-second cache includes failures and concurrent reads share one in-flight lookup', async t => {
  let now = 1000, calls = 0, firstCallback, unavailable = false;
  t.mock.method(Date, 'now', () => now);
  const read = reader((file, args, options, callback) => {
    calls++;
    if (unavailable) return callback({ code: 'ENOENT' }, '', '');
    if (calls === 1) { firstCallback = () => executor()(file, args, options, callback); return; }
    executor()(file, args, options, callback);
  });
  const first = read(), second = read();
  assert.equal(calls, 1);
  firstCallback();
  const values = await Promise.all([first, second]);
  assert.deepEqual(values[0], values[1]);
  assert.equal(calls, 3);
  now = 2999; assert.deepEqual(await read(), values[0]); assert.equal(calls, 3);
  now = 3000; unavailable = true;
  const failure = await read();
  assert.equal(failure.status, 'unavailable'); assert.equal(calls, 4);
  now = 4999; assert.deepEqual(await read(), failure); assert.equal(calls, 4);
  now = 5000; assert.deepEqual(await read(), failure); assert.equal(calls, 5);
});

test('a concurrent checkout never combines mismatched branch and HEAD metadata', async () => {
  let branches = 0;
  const value = await reader((_file, args, _options, callback) => callback(null,
    args.includes('symbolic-ref') ? (++branches === 1 ? 'before\n' : 'after\n') : `${head}\n`, ''))();
  assert.equal(value.status, 'unknown');
  assert.deepEqual(Object.keys(value), ['id', 'status']);
});

test('a stalled executor is killed and late callbacks cannot replace the unknown result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let killed, callback;
  const read = reader((_file, _args, _options, done) => {
    callback = done;
    return { kill(signal) { killed = signal; } };
  });
  const pending = read();
  t.mock.timers.tick(2000);
  const value = await pending;
  assert.equal(value.status, 'unknown');
  assert.equal(killed, 'SIGKILL');
  callback(null, 'main\n', '');
  assert.deepEqual(await read(), value);
});

test('transient failures retain the confirmed identity as unavailable, then detect actual HEAD and branch changes', async t => {
  let now = 1000, unavailable = false, branch = 'main', commit = head, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const read = reader((...args) => {
    calls++;
    return executor({ branch, commit, ...(unavailable ? { error: { killed: true } } : {}) })(...args);
  });
  const first = await read();
  now += 2000; unavailable = true;
  const failed = await read();
  assert.deepEqual(failed, { ...first, status: 'unavailable' });
  assert.equal(Object.isFrozen(failed), true);
  assert.equal(calls, 4);
  now += 1999;
  assert.deepEqual(await read(), failed);
  assert.equal(calls, 4, 'failed lookups are bounded by the existing cache interval');
  now++; unavailable = false;
  assert.deepEqual(await read(), first);
  now += 2000; commit = 'b'.repeat(40);
  const changedHead = await read();
  assert.notEqual(changedHead.id, first.id);
  now += 2000; branch = 'another';
  assert.notEqual((await read()).id, changedHead.id);
});

test('an overdue watchdog lets completed child callbacks drain after a busy event-loop turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callback, killed = false, first = true;
  const read = reader((file, args, options, done) => {
    if (!first) return executor()(file, args, options, done);
    first = false;
    callback = () => executor()(file, args, options, done);
    return { kill() { killed = true; } };
  });
  const pending = read();
  t.mock.timers.tick(2000);
  setImmediate(callback);
  assert.equal((await pending).status, 'git');
  assert.equal(killed, false, 'a ready child callback wins over delayed parent timeout handling');
});

test('real local Git reads synthetic refs and non-Git directories without commits or network', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'graphlin-lineage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const read = createLineageReader({ projectRoot: directory, projectId });
  assert.equal((await read()).status, 'not_git');
  await mkdir(path.join(directory, '.git', 'objects'), { recursive: true });
  await mkdir(path.join(directory, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(directory, '.git', 'refs', 'heads', 'main'), `${head}\n`);
  const git = await createLineageReader({ projectRoot: directory, projectId })();
  assert.equal(git.status, 'git'); assert.equal(git.branch, 'main'); assert.equal(git.head, head);
  await writeFile(path.join(directory, '.git', 'HEAD'), `${head}\n`);
  const detached = await createLineageReader({ projectRoot: directory, projectId })();
  assert.equal(detached.status, 'git'); assert.equal(detached.head, head);
  assert.equal(detached.branch, undefined);
});

test('a real unborn repository has explicit unknown lineage until its first HEAD can be confirmed', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'graphlin-unborn-lineage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, '.git', 'objects'), { recursive: true });
  await mkdir(path.join(directory, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const read = createLineageReader({ projectRoot: directory, projectId });
  const unknown = await read();
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(Object.keys(unknown), ['id', 'status']);
  await writeFile(path.join(directory, '.git', 'refs', 'heads', 'main'), `${head}\n`);
  now += 2000;
  const confirmed = await read();
  assert.equal(confirmed.status, 'git');
  assert.notEqual(confirmed.id, unknown.id);
  await rm(path.join(directory, '.git', 'refs', 'heads', 'main'));
  now += 2000;
  assert.deepEqual(await read(), { ...confirmed, status: 'unavailable' });
});

test('invalid construction fails with a fixed error before executing Git', () => {
  for (const options of [
    {}, { projectRoot: 'relative', projectId }, { projectRoot: '/fixture/\0', projectId },
    { projectRoot, projectId: '../unsafe' }, { projectRoot, projectId, execute: null },
  ]) assert.throws(() => createLineageReader(options), /^TypeError: invalid_lineage_options$/);
});
