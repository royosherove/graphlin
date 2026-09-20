import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile, symlink, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildPackages } from '../../scripts/build-packages.mjs';
import { publicPackageFiles, validatePackage } from '../../scripts/validate-packages.mjs';
import { assertPublicContents, verifyNpmPack } from '../../.github/scripts/verify-pack.mjs';
import { verifyReleaseContext } from '../../.github/scripts/verify-release.mjs';
import { workspace } from './helpers.mjs';

test('package preflight rejects linked output files and destination ancestors without writes', async t => {
  for (const destination of ['kiro/README.md', 'kiro/profile.json', 'kiro', 'portable',
    'claude/graphlin', 'codex/graphlin/.graphlin-package', 'codex/.agents', 'codex/.agents/plugins',
    'codex/.agents/plugins/marketplace.json', 'output', 'ancestor']) {
    await t.test(destination, async t => {
      const { base } = await workspace(t);
      const outside = path.join(base, 'unrelated directory'), sentinel = path.join(outside, 'sentinel');
      await mkdir(outside);
      await writeFile(sentinel, 'unrelated contents must survive');
      let output = path.join(base, 'generated packages'), link;
      if (destination === 'output' || destination === 'ancestor') {
        link = output;
        await symlink(outside, link);
        if (destination === 'ancestor') output = path.join(output, 'nested', 'packages');
      } else {
        link = path.join(output, destination);
        await mkdir(path.dirname(link), { recursive: true });
        const isFile = /README\.md|profile\.json|marketplace\.json|\.graphlin-package$/.test(destination);
        await symlink(isFile ? sentinel : outside, link);
      }
      await assert.rejects(buildPackages({ outputDir: output }), /package_destination_symlink_rejected/);
      assert.equal(await readFile(sentinel, 'utf8'), 'unrelated contents must survive');
      assert.deepEqual(await readdir(outside), ['sentinel']);
      assert.equal((await lstat(link)).isSymbolicLink(), true);
      // Preflight must finish before generating or replacing any profile.
      await assert.rejects(lstat(path.join(output, 'portable/graphlin/.graphlin-package')), { code: 'ENOENT' });
    });
  }
});

test('repeat builds include a portable local Codex marketplace and an inactive Kiro profile', async t => {
  const { base } = await workspace(t), outputDir = path.join(base, 'packages with spaces');
  for (let generation = 0; generation < 2; generation++) {
    const packages = await buildPackages({ outputDir });
    assert.equal(packages.length, 3);
    for (const { directory } of packages) assert.equal((await validatePackage(directory)).valid, true);
    const kiro = path.join(outputDir, 'kiro');
    assert.equal((await lstat(path.join(kiro, 'README.md'))).isSymbolicLink(), false);
    assert.match(await readFile(path.join(kiro, 'README.md'), 'utf8'), /inactive experimental/);
    assert.equal(JSON.parse(await readFile(path.join(kiro, 'profile.json'), 'utf8')).enabled, false);
    assert.deepEqual((await readdir(kiro)).sort(), ['README.md', 'profile.json']);
    const marketplace = JSON.parse(await readFile(path.join(outputDir, 'codex/.agents/plugins/marketplace.json'), 'utf8'));
    assert.deepEqual(marketplace, {
      name: 'graphlin-local', interface: { displayName: 'Graphlin local' },
      plugins: [{ name: 'graphlin', source: { source: 'local', path: './graphlin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
    });
    const pluginRoot = path.resolve(outputDir, 'codex', marketplace.plugins[0].source.path);
    assert.equal(pluginRoot, packages.find(item => item.profile === 'codex').directory);
    assert.equal(JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8')).name, 'graphlin');
    assert.equal(JSON.stringify(marketplace).includes(base), false, 'marketplace remains portable after relocation');
  }
});

async function sourceFixture(t) {
  const { base } = await workspace(t), sourceDir = path.join(base, 'source');
  for (const file of await publicPackageFiles(process.cwd())) {
    const destination = path.join(sourceDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.resolve(file), destination);
  }
  return { base, sourceDir, outputDir: path.join(base, 'packages') };
}

test('npm and plugin bundles contain only allowlisted public files and install a working graphlin bin', async t => {
  const { sourceDir, outputDir } = await sourceFixture(t);
  const excluded = ['.env', '.env.local', '.npmrc', '.graphlin/state.json', '.graphlin-local/AGENTS.md', '.visualive/github-relay.json',
    'research/private.md', 'ops/private.json', 'docs/personal.md', 'runtime/local.env',
    'runtime/core/README.md', 'runtime/core/LICENSE', 'runtime/core/plugin.json', 'runtime/core/.mcp.json',
    'scripts/operator-notes.mjs', 'skills/graphlin/local-settings.json', 'adapters/codex/local-settings.json'];
  for (const file of excluded) {
    const destination = path.join(sourceDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'PRIVATE_PACKAGE_SENTINEL');
  }
  for (const { directory } of await buildPackages({ sourceDir, outputDir })) {
    for (const file of excluded) await assert.rejects(lstat(path.join(directory, file)), { code: 'ENOENT' });
    assert.match(await readFile(path.join(directory, 'LICENSE'), 'utf8'), /MIT License/);
  }
  const result = await verifyNpmPack(sourceDir);
  assert.equal(result.name, 'graphlin');
  assert.equal(result.installedCli, true);
});

test('package source links are rejected before output is created', async t => {
  for (const filename of ['runtime/local-secret.mjs', 'scripts/graphlin.mjs']) {
    await t.test(filename, async t => {
      const { base, sourceDir, outputDir } = await sourceFixture(t);
      const secret = path.join(base, 'secret');
      await writeFile(secret, 'PRIVATE_PACKAGE_SENTINEL');
      const target = path.join(sourceDir, filename);
      if (filename === 'scripts/graphlin.mjs') {
        const { unlink } = await import('node:fs/promises');
        await unlink(target);
      }
      await symlink(secret, target);
      await assert.rejects(buildPackages({ sourceDir, outputDir }), /package_symlink_rejected/);
      await assert.rejects(lstat(outputDir), { code: 'ENOENT' });
      assert.equal(await readFile(secret, 'utf8'), 'PRIVATE_PACKAGE_SENTINEL');
    });
  }
});

test('unmanaged package destinations and unsafe output directories are preserved', async t => {
  const { sourceDir, outputDir } = await sourceFixture(t);
  const sentinel = path.join(outputDir, 'portable/graphlin/sentinel');
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, 'keep');
  await assert.rejects(buildPackages({ sourceDir, outputDir }), /unmanaged_output_directory/);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  for (const directory of [sourceDir, path.dirname(sourceDir), path.join(sourceDir, 'runtime/nested')]) {
    await assert.rejects(buildPackages({ sourceDir, outputDir: directory }), /unsafe_output_directory/);
  }
});

test('release guard requires an authorized public repository and exact stable version tag', () => {
  const metadata = { name: 'graphlin', private: false, version: '0.1.0' };
  const context = { repository: 'royosherove/graphlin', isPrivate: false, enabled: 'true',
    event: 'push', ref: 'refs/tags/v0.1.0' };
  assert.doesNotThrow(() => verifyReleaseContext(context, metadata));
  for (const replacement of [
    { repository: 'someone/graphlin' }, { isPrivate: true }, { isPrivate: undefined },
    { enabled: undefined }, { enabled: 'false' }, { event: 'pull_request' },
    { ref: 'refs/tags/v0.2.0' }, { ref: 'refs/heads/v0.1.0' },
  ]) assert.throws(() => verifyReleaseContext({ ...context, ...replacement }, metadata));
  for (const replacement of [
    { name: 'visualive' }, { private: true }, { private: undefined },
    { version: '0.1.0-beta.1' }, { version: '00.1.0' },
  ]) assert.throws(() => verifyReleaseContext(context, { ...metadata, ...replacement }));
});

test('public file allowlist rejects unanchored paths, traversal, wildcards, and private material', async t => {
  const { sourceDir } = await sourceFixture(t);
  const filename = path.join(sourceDir, 'package.json');
  const metadata = JSON.parse(await readFile(filename, 'utf8'));
  for (const file of ['README.md', './../outside', './runtime/**', './.graphlin-local/AGENTS.md']) {
    await writeFile(filename, JSON.stringify({ ...metadata, files: [...metadata.files, file] }));
    await assert.rejects(publicPackageFiles(sourceDir), /package_file|public_package_file/);
  }
});

test('public package scanner rejects credentials and identifying machine paths without echoing them', () => {
  const sensitive = [
    '/Users/' + 'example/private', '/home/' + 'example/private', 'C:\\Users\\' + 'example\\private',
    'AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), 'npm_' + 'x'.repeat(36),
    'ghp_' + 'x'.repeat(36), 'github_pat_' + 'x'.repeat(60),
    '-----BEGIN PRIVATE KEY-----\n' + 'x'.repeat(64),
  ];
  for (const value of sensitive) assert.throws(() => assertPublicContents(value), error => !error.message.includes(value));
  assert.doesNotThrow(() => assertPublicContents('TYPESAFE_API_KEY is read from the environment.'));
});
