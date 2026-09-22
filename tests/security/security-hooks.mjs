// Explicit security-job tests: require the verified external tools, never skip
// when missing and never download or use a real credential during a test.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSecurity, checkGenericSecurity, securityRepository, runTool,
  setupSecurityScanner, verifyScanner, securityFileId } from '../../scripts/security-check.mjs';
import { installSecurityHooks } from '../../scripts/install-security-hooks.mjs';

const scanner = process.env.GRAPHLIN_TEST_SCANNER ??
  path.join((await securityRepository()).toolDir, 'git-secrets');
await verifyScanner(scanner);
const genericScanner = process.env.GRAPHLIN_TEST_GITLEAKS;
assert.ok(genericScanner, 'Set GRAPHLIN_TEST_GITLEAKS to the verified Gitleaks 8.30.1 binary.');
const priorGitConfig = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']
  .map(key => [key, process.env[key]]));
before(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
after(() => {
  for (const [key, value] of Object.entries(priorGitConfig)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const toolFiles = new Map(await Promise.all(['git-secrets', 'LICENSE.txt', 'NOTICE.txt'].map(async name =>
  [name, await readFile(path.join(path.dirname(scanner), name))])));
const fetchFixture = async url => new Response(toolFiles.get(new URL(url).pathname.split('/').at(-1)));
const accessKey = () => ['AK', 'IA', '9'.repeat(16)].join('');
const secretKey = () => 'Ab9/'.repeat(10);
const npmToken = () => ['np', 'm_', 'Ab8kMn3sPq9tWx2yZe7uRv5jHd4cLf6gNo1b'].join('');
const scriptSource = name => new URL(`../../scripts/${name}`, import.meta.url);
const missing = filename => assert.rejects(lstat(filename), { code: 'ENOENT' });
const env = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
async function git(root, ...args) {
  const result = await runTool('git', ['-c', 'core.fsmonitor=false', '-c', 'init.templateDir=',
    '-c', 'user.name=Security fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, env: env() });
  if (result.code) throw new Error('synthetic_git_failed');
  return result.stdout;
}
async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-security-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'init', '--quiet');
  return root;
}
async function stage(root, name, text) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
  await git(root, 'add', '--', name);
}
async function scan(root, options = {}) {
  return checkSecurity({ projectRoot: root, scannerPath: scanner, ...options });
}
async function install(root) {
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(scriptSource('security-check.mjs'), path.join(root, 'scripts', 'security-check.mjs'));
  return installSecurityHooks({ projectRoot: root, fetchFile: fetchFixture });
}
function redacted(rows, values) {
  const output = JSON.stringify(rows);
  for (const value of values) assert.ok(!output.includes(value), 'detected value must not escape');
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['file', 'line', 'rule']);
}

test('AWS access IDs and secret assignments block staged blobs, with only redacted locations', async t => {
  const root = await repository(t);
  await stage(root, 'aws.config', `public\naccess_key = "${accessKey()}"\naws_secret_access_key = "${secretKey()}"\n`);
  const rows = await scan(root);
  assert.ok(rows.some(row => row.file === securityFileId('aws.config') && row.line === 2 && row.rule === 'aws-access-key-id'));
  assert.ok(rows.some(row => row.file === securityFileId('aws.config') && row.line === 3 && row.rule === 'aws-secret-access-key'));
  redacted(rows, [accessKey(), secretKey()]);
});

test('cleaning an unstaged worktree cannot hide a staged secret; unstaged secrets do not change the index check', async t => {
  const root = await repository(t);
  await stage(root, 'example.txt', `${accessKey()}\n`);
  await writeFile(path.join(root, 'example.txt'), 'clean worktree\n');
  assert.equal((await scan(root)).length, 1);
  await git(root, 'add', '--', 'example.txt');
  await writeFile(path.join(root, 'example.txt'), `${accessKey()}\n`);
  assert.deepEqual(await scan(root), []);
});

test('clean documentation passes, including filenames with colon/newline characters', async t => {
  const root = await repository(t);
  await stage(root, 'docs/usage.md', 'Use AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.\n');
  assert.deepEqual(await scan(root), []);
  const name = 'docs/colon:12:\nreport.md';
  await stage(root, name, `example\n${accessKey()}\n`);
  const rows = await scan(root);
  assert.equal(rows[0].file, securityFileId(name));
  assert.equal(rows[0].line, 2);
  redacted(rows, [accessKey()]);
});

test('assignment whitespace/quotes, account IDs, and secret-bearing filenames use AWS grep semantics with opaque output', async t => {
  const root = await repository(t), account = ['1234', '5678', '9012'].join('');
  const name = `${accessKey()}:\u001b[31m.txt`;
  await stage(root, name, `"aws_secret_access_key"\t =  "${secretKey()}"\nAWS_ACCOUNT_ID = "${account}"\n`);
  const rows = await scan(root);
  assert.ok(rows.some(row => row.line === 1 && row.rule === 'aws-secret-access-key'));
  assert.ok(rows.some(row => row.line === 2 && row.rule === 'aws-account-id'));
  assert.ok(rows.every(row => row.file === securityFileId(name)));
  redacted(rows, [name, accessKey(), secretKey(), account, '\u001b']);
});

test('isolated rules ignore repository allowances and providers, without changing Git configuration', async t => {
  const root = await repository(t), marker = path.join(root, 'provider-ran');
  await git(root, 'config', '--add', 'secrets.allowed', '.*');
  await git(root, 'config', '--add', 'secrets.providers', `touch ${marker}`);
  await stage(root, '.gitallowed', '.*\n');
  await stage(root, 'config.txt', `${accessKey()}\n`);
  const before = await readFile(path.join(root, '.git', 'config'));
  assert.equal((await scan(root)).length, 1);
  assert.deepEqual(await readFile(path.join(root, '.git', 'config')), before);
  await missing(marker);
});

test('the AWS credential-file provider is absent even when HOME contains synthetic credentials', async t => {
  const root = await repository(t), previous = process.env.HOME;
  await mkdir(path.join(root, '.aws'));
  await writeFile(path.join(root, '.aws', 'credentials'), '[default]\naws_secret_access_key=UNIQUE_SHORT_SENTINEL\n');
  process.env.HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  await stage(root, 'docs.md', 'UNIQUE_SHORT_SENTINEL\n');
  assert.deepEqual(await scan(root), []);
});

test('a temporary Git commit index is honored', async t => {
  const root = await repository(t);
  await stage(root, 'config.txt', `${accessKey()}\n`);
  const index = path.join(root, '.git', 'temporary-index');
  await copyFile(path.join(root, '.git', 'index'), index);
  await writeFile(path.join(root, 'config.txt'), 'safe\n');
  await git(root, 'add', '--', 'config.txt');
  const before = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = index;
  t.after(() => { if (before === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = before; });
  assert.equal((await scan(root)).length, 1);
});

test('history detects removed secrets and historical messages, including non-HEAD branches', async t => {
  const root = await repository(t);
  await stage(root, 'gone.txt', `${accessKey()}\n`);
  await git(root, 'commit', '--quiet', '-m', 'synthetic first');
  await git(root, 'branch', 'fixture-history');
  await git(root, 'rm', '--', 'gone.txt');
  await git(root, 'commit', '--quiet', '-m', `synthetic ${accessKey()}`);
  await stage(root, 'readme.md', 'clean\n');
  await git(root, 'commit', '--quiet', '-m', 'clean tip');
  assert.deepEqual(await scan(root), []);
  const rows = await scan(root, { mode: 'history' });
  const revisions = (await git(root, 'log', '--all', '--format=%H')).trim().split('\n');
  assert.ok(rows.some(row => revisions.some(revision => row.file === securityFileId(`${revision}:gone.txt`))));
  assert.ok(rows.some(row => revisions.some(revision => row.file === securityFileId(`${revision}:COMMIT_EDITMSG`))));
  redacted(rows, [accessKey()]);
});

test('an empty history passes but a shallow history fails closed', async t => {
  const root = await repository(t);
  assert.deepEqual(await scan(root, { mode: 'history' }), []);
  await stage(root, 'readme.md', 'clean\n');
  await git(root, 'commit', '--quiet', '-m', 'clean');
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  await writeFile(path.join(root, '.git', 'shallow'), `${head}\n`);
  await assert.rejects(scan(root, { mode: 'history' }), { code: 'security_shallow_history' });
});

test('history detects credentials introduced only by a merge resolution and later deleted', async t => {
  const root = await repository(t);
  await stage(root, 'README.md', 'clean base\n');
  await git(root, 'commit', '--quiet', '-m', 'synthetic base');
  const initialBranch = (await git(root, 'branch', '--show-current')).trim();
  await git(root, 'checkout', '--quiet', '-b', 'fixture-feature');
  await stage(root, 'feature.txt', 'clean feature\n');
  await git(root, 'commit', '--quiet', '-m', 'synthetic feature');
  await git(root, 'checkout', '--quiet', initialBranch);
  await stage(root, 'main.txt', 'clean main\n');
  await git(root, 'commit', '--quiet', '-m', 'synthetic main');
  await git(root, 'merge', '--no-ff', '--no-commit', 'fixture-feature');
  await stage(root, 'merge-only.txt', `${accessKey()}\ntoken=${npmToken()}\n`);
  await git(root, 'commit', '--quiet', '-m', 'synthetic merge resolution');
  const merge = (await git(root, 'rev-parse', 'HEAD')).trim();
  assert.equal((await git(root, 'rev-list', '--parents', '-n', '1', merge)).trim().split(' ').length, 3);
  await git(root, 'rm', '--', 'merge-only.txt');
  await git(root, 'commit', '--quiet', '-m', 'clean merge result');
  assert.deepEqual(await scan(root), []);
  const aws = await scan(root, { mode: 'history' });
  assert.ok(aws.some(row => row.file === securityFileId(`${merge}:merge-only.txt`) && row.rule === 'aws-access-key-id'));
  const generic = await checkGenericSecurity({ projectRoot: root, scannerPath: genericScanner });
  assert.ok(generic.some(row => row.file === securityFileId('merge-only.txt') && row.rule === 'npm-access-token'));
  redacted([...aws, ...generic], [accessKey(), npmToken()]);
});

test('hook installation is opt-in and idempotent, preserves config and other hooks', async t => {
  const root = await repository(t);
  await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  const other = path.join(root, '.git', 'hooks', 'pre-push');
  await writeFile(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const before = await readFile(path.join(root, '.git', 'config'));
  await scan(root);
  await missing(path.join(root, '.git', 'hooks', 'pre-commit'));
  await install(root);
  const first = await readFile(path.join(root, '.git', 'hooks', 'pre-commit'));
  await install(root);
  assert.deepEqual(await readFile(path.join(root, '.git', 'hooks', 'pre-commit')), first);
  assert.deepEqual(await readFile(path.join(root, '.git', 'config')), before);
  assert.equal(await readFile(other, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('existing hook files, hook symlinks, and core.hooksPath are preserved without partial activation', async t => {
  for (const kind of ['pre-commit', 'commit-msg', 'symlink', 'custom path', 'global path']) await t.test(kind, async t => {
    const root = await repository(t);
    await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    const sentinel = path.join(root, 'existing-hook');
    await writeFile(sentinel, '#!/bin/sh\nexit 0\n');
    if (kind === 'global path') {
      const filename = path.join(root, 'global-config');
      await writeFile(filename, '[core]\n hooksPath = custom-global-hooks\n');
      const previous = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = filename;
      t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
    } else if (kind === 'custom path') await git(root, 'config', 'core.hooksPath', 'custom-hooks');
    else if (kind === 'symlink') await symlink(sentinel, path.join(root, '.git', 'hooks', 'pre-commit'));
    else await copyFile(sentinel, path.join(root, '.git', 'hooks', kind));
    const config = await readFile(path.join(root, '.git', 'config'));
    await assert.rejects(install(root), { code: 'security_hooks_conflict' });
    assert.deepEqual(await readFile(path.join(root, '.git', 'config')), config);
    assert.equal(await readFile(sentinel, 'utf8'), '#!/bin/sh\nexit 0\n');
    await missing(path.join(root, '.git', 'graphlin-security'));
    if (kind !== 'commit-msg') await missing(path.join(root, '.git', 'hooks', 'commit-msg'));
  });
});

test('history scans never invoke repository textconv programs', async t => {
  const root = await repository(t), marker = path.join(root, 'textconv-ran');
  const converter = path.join(root, '.git', 'converter');
  await writeFile(converter, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
    { mode: 0o755 });
  await stage(root, '.gitattributes', '*.txt diff=fixture\n');
  await stage(root, 'file.txt', `${accessKey()}\ntoken=${npmToken()}\n`);
  await git(root, 'commit', '--quiet', '-m', 'synthetic textconv fixture');
  await git(root, 'config', 'diff.fixture.textconv', converter);
  assert.ok((await scan(root, { mode: 'history' })).length);
  await missing(marker);
  assert.ok((await checkGenericSecurity({ projectRoot: root, scannerPath: genericScanner })).length);
  await missing(marker);
});

test('real installed hooks reject staged and commit-message secrets without leaking values to Git output', async t => {
  const root = await repository(t);
  await install(root);
  await stage(root, 'file.txt', `${accessKey()}\n`);
  await writeFile(path.join(root, 'file.txt'), 'clean unstaged\n');
  const commit = args => runTool('git', ['-c', 'user.name=Security fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', ...args],
  { cwd: root, env: env() });
  let result = await commit(['-m', 'safe message']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /aws-access-key-id/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(accessKey()));
  await git(root, 'add', '--', 'file.txt');
  result = await commit(['-m', `synthetic ${accessKey()}`]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(securityFileId('COMMIT_EDITMSG')));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(accessKey()));
  assert.equal((await commit(['-m', 'safe message'])).code, 0);
  await rm(path.join(root, '.git', 'graphlin-security', 'git-secrets'));
  result = await commit(['--allow-empty', '-m', 'missing scanner']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Pinned git-secrets/);
});

test('tool checksum mismatches fail closed and never activate hooks', async t => {
  const root = await repository(t), directory = path.join(root, '.git', 'graphlin-security');
  await assert.rejects(setupSecurityScanner(directory, { fetchFile: async () => new Response('changed tool') }),
    { code: 'security_tool_integrity' });
  await missing(path.join(directory, 'git-secrets'));
  await missing(path.join(root, '.git', 'hooks', 'pre-commit'));
  await writeFile(path.join(directory, 'git-secrets'), 'changed tool', { mode: 0o600 });
  await assert.rejects(scan(root, { scannerPath: path.join(directory, 'git-secrets') }), { code: 'security_tool_integrity' });
});

test('Gitleaks detects generic-provider history despite inline and repository allowances; output stays redacted', async t => {
  const root = await repository(t);
  const filename = `${npmToken()}.txt`;
  await stage(root, filename, `token=${npmToken()} # gitleaks:allow\n`);
  await stage(root, '.gitleaks.toml', '[allowlist]\npaths = [".*"]\n');
  await git(root, 'commit', '--quiet', '-m', 'synthetic provider credential');
  await git(root, 'rm', '--', filename);
  await git(root, 'commit', '--quiet', '-m', 'clean current tree');
  const rows = await checkGenericSecurity({ projectRoot: root, scannerPath: genericScanner });
  assert.ok(rows.some(row => row.rule === 'npm-access-token' && row.file === securityFileId(filename)));
  redacted(rows, [npmToken(), filename]);
  const clean = await repository(t);
  await stage(clean, 'README.md', 'Configure an npm token outside the repository.\n');
  await git(clean, 'commit', '--quiet', '-m', 'clean docs');
  assert.deepEqual(await checkGenericSecurity({ projectRoot: clean, scannerPath: genericScanner }), []);
  await assert.rejects(checkGenericSecurity({ projectRoot: clean, scannerPath: path.join(clean, 'missing') }),
    { code: 'security_check_unavailable' });
});

test('default Node discovery does not run the dedicated external-tool suite', async t => {
  const root = await repository(t);
  await mkdir(path.join(root, 'tests', 'security'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'default.test.mjs'), "import test from 'node:test'; test('ordinary test', () => {});\n");
  await writeFile(path.join(root, 'tests', 'security', 'security-hooks.mjs'), "throw new Error('security_suite_was_duplicated');\n");
  const result = await runTool(process.execPath, ['--test'], { cwd: root });
  assert.equal(result.code, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('security_suite_was_duplicated'));
});

test('one independent full-history security job gates the reusable release checks', async () => {
  const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const job = ci.match(/^  security:\n([\s\S]*?)(?=^  test:)/m)?.[1];
  assert.ok(job);
  assert.doesNotMatch(job, /needs:|strategy:|matrix:|continue-on-error/);
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /security-check\.mjs history/);
  assert.match(job, /security-check\.mjs generic-history/);
  assert.match(job, /gitleaks_8\.30\.1_linux_x64\.tar\.gz/);
  assert.match(job, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(job, /sha256sum --check --status/);
  assert.match(release, /checks:\n    uses: \.\/\.github\/workflows\/ci.yml/);
  assert.match(release, /publish:\n    needs: \[guard, checks\]/);
});
