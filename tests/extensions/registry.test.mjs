import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  createExtensionRegistry, readPackageArchive, parsePackageSpec,
  MANIFEST_FILE, bundleDigest, npmPackTransport,
} from '../../runtime/extensions/index.mjs';
import { runExtensions } from '../../scripts/extensions.mjs';
import { localPackage, packageFiles, archive, tar, PROJECT, profile } from './fixtures.mjs';

test('local installation copies self-contained immutable assets and grants only the project/digest', async t => {
  const fixture = await localPackage(t);
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const row = await registry.install(fixture.directory);
  assert.equal(row.grant, null);
  assert.equal(row.digest, bundleDigest(fixture.manifest));
  const loaded = await registry.getAssets('example.c4');
  assert.deepEqual(loaded.assets, fixture.assets);
  assert.deepEqual(await readdir(path.join(fixture.dataDir, 'extensions/staging')), []);
  const current = await registry.grant(row.id, { digest: row.digest, fields: ['entities', 'relations'], history: false, approved: true });
  assert.equal(current.projectId, PROJECT);
  assert.deepEqual(await registry.getGrant(row.id), current);
  const other = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: 'other-project' });
  assert.equal(await other.getGrant(row.id), null);
  await writeFile(path.join(fixture.directory, 'dist/visualizer.js'), 'changed after installation');
  assert.deepEqual((await registry.getAssets(row.id)).assets, fixture.assets);
  await registry.revoke(row.id);
  assert.equal(await registry.getGrant(row.id), null);
  const catalogue = await lstat(path.join(fixture.dataDir, 'extensions/catalogue.json'));
  assert.equal(catalogue.mode & 0o077, 0);
  await assert.rejects(readFile(path.join(fixture.directory, 'DO-NOT-RUN')), { code: 'ENOENT' });
});

test('invalid update rolls back; valid update clears grants and retains previous immutable package', async t => {
  const fixture = await localPackage(t);
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const first = await registry.install(fixture.directory);
  await registry.grant(first.id, { digest: first.digest, fields: ['entities'], history: false, approved: true });
  const previousPath = path.join(fixture.dataDir, 'extensions/bundles', first.id, first.version, first.digest);
  await writeFile(path.join(fixture.directory, 'dist/visualizer.js'), 'invalid hash');
  await assert.rejects(registry.install(fixture.directory), /integrity/);
  assert.equal((await registry.list())[0].digest, first.digest);
  assert.ok(await registry.getGrant(first.id));
  assert.deepEqual(await readdir(path.join(fixture.dataDir, 'extensions/staging')), []);
  const secondPackage = packageFiles({ version: '1.0.1', source: 'window.changed = true;' });
  for (const [name, bytes] of Object.entries(secondPackage.files)) await writeFile(path.join(fixture.directory, name), bytes);
  const second = await registry.install(fixture.directory);
  assert.notEqual(second.digest, first.digest);
  assert.equal(await registry.getGrant(first.id), null);
  assert.equal((await lstat(previousPath)).isDirectory(), true);
  await assert.rejects(registry.grant(first.id, { digest: first.digest, fields: ['entities'], history: false, approved: true }),
    /digest_changed/);
  await assert.rejects(registry.getAssets(first.id, { digest: first.digest }), /digest_changed/);
  await registry.remove(first.id);
  assert.deepEqual(await registry.list(), []);
  await assert.rejects(registry.getAssets(first.id), /not_installed/);
});

test('cancellation and transport failure leave the current installation unchanged', async t => {
  const fixture = await localPackage(t);
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const installed = await registry.install(fixture.directory);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(registry.install(fixture.directory, { signal: controller.signal }), /cancelled/);
  assert.equal((await registry.list())[0].digest, installed.digest);
  const malicious = await createExtensionRegistry({
    dataDir: fixture.dataDir, projectId: PROJECT,
    transport: async (_, { signal }) => { assert.equal(signal, undefined); throw new Error('synthetic transport failure'); },
  });
  await assert.rejects(malicious.install('synthetic-c4@2.0.0'));
  assert.equal((await registry.list())[0].digest, installed.digest);
  assert.deepEqual(await readdir(path.join(fixture.dataDir, 'extensions/staging')), []);
});

test('npm CLI transport pins ignore-scripts, isolates configuration, and uses no shell or registry in tests', async t => {
  const fixture = await localPackage(t);
  const bin = path.join(fixture.root, 'bin'), destination = path.join(fixture.root, 'pack');
  await mkdir(bin); await mkdir(destination, { mode: 0o700 });
  const archivePath = path.join(fixture.root, 'fixture.tgz');
  await writeFile(archivePath, archive(fixture.files));
  const npm = path.join(bin, 'npm');
  await writeFile(npm, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args[0], 'pack');
assert.ok(args.includes('--ignore-scripts'));
assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
assert.equal(args.at(-1), 'synthetic-c4@1.0.0');
assert.equal(process.env.npm_config_ignore_scripts, 'true');
assert.notEqual(process.env.npm_config_userconfig, process.env.npm_config_globalconfig);
assert.equal(process.env.TYPESAFE_API_KEY, undefined);
assert.equal(process.env.NPM_TOKEN, undefined);
const dest = args[args.indexOf('--pack-destination') + 1];
fs.copyFileSync(${JSON.stringify(archivePath)}, path.join(dest, 'synthetic-c4-1.0.0.tgz'));
process.stdout.write(JSON.stringify([{filename:'synthetic-c4-1.0.0.tgz'}]));
`);
  await chmod(npm, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  try {
    const bytes = await npmPackTransport('synthetic-c4@1.0.0', { directory: destination });
    assert.equal(readPackageArchive(bytes, 'synthetic-c4@1.0.0').manifest.id, fixture.manifest.id);
  } finally { process.env.PATH = previous; }
});

test('installed asset navigation rejects encoded paths, undeclared files and symlinks', async t => {
  const fixture = await localPackage(t);
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const row = await registry.install(fixture.directory);
  for (const assetPath of [
    '../catalogue.json', '/etc/passwd', 'dist/../visualizer.js', 'dist/%2e%2e/visualizer.js',
    'dist\\visualizer.js', 'dist/visualizer.js?query', 'dist/visualizer.js#hash',
    'dist//visualizer.js', 'package.json', '//example.invalid/evil.js',
  ]) await assert.rejects(registry.getAssets(row.id, { assetPath }));
  const asset = await registry.getAssets(row.id, { assetPath: 'dist/visualizer.js' });
  assert.deepEqual(asset.bytes, fixture.assets['dist/visualizer.js']);
  const installedFile = path.join(fixture.dataDir, 'extensions/bundles', row.id, row.version, row.digest, 'dist/visualizer.js');
  await chmod(installedFile, 0o600);
  await writeFile(installedFile, 'tampered');
  const report = await registry.doctor();
  assert.equal(report.ok, false);
  assert.equal(report.results[0].code, 'asset_integrity_mismatch');
  await assert.rejects(registry.getAssets(row.id), /integrity/);
});

test('local symlinks, symlink ancestors and undeclared files are rejected without reading contents', async t => {
  const fixture = await localPackage(t);
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  await writeFile(path.join(fixture.directory, 'unexpected.js'), 'never run');
  await assert.rejects(registry.install(fixture.directory), /undeclared/);
  const second = await localPackage(t);
  await symlink(second.directory, path.join(second.root, 'linked'));
  await assert.rejects(registry.install(path.join(second.root, 'linked')), /unsafe/);
  await symlink(path.join(second.directory, 'dist/visualizer.js'), path.join(second.directory, 'dist/linked.js'));
  await assert.rejects(registry.install(second.directory), /unsafe|undeclared/);
  const third = await localPackage(t);
  await mkdir(third.dataDir, { mode: 0o700 });
  await symlink(third.directory, path.join(third.dataDir, 'extensions'));
  await assert.rejects(createExtensionRegistry({ dataDir: third.dataDir, projectId: PROJECT }), /unsafe/);
});

test('npm installation uses injected transport and validates tar bytes before registration', async t => {
  const fixture = await localPackage(t);
  const calls = [];
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT,
    transport: async (spec, context) => {
      calls.push(spec);
      assert.ok(context.directory.startsWith(fixture.dataDir));
      return archive(fixture.files);
    } });
  const row = await registry.install('synthetic-c4@1.0.0');
  assert.equal(row.id, fixture.manifest.id);
  assert.deepEqual(calls, ['synthetic-c4@1.0.0']);
  assert.equal((await registry.doctor()).ok, true);
  for (const spec of ['synthetic-c4', 'synthetic-c4@latest', 'synthetic-c4@^1', 'https://example.invalid/x.tgz', 'git+ssh:x']) {
    await assert.rejects(registry.install(spec));
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(parsePackageSpec('@scope/c4@1.2.3-beta.1'), { name: '@scope/c4', version: '1.2.3-beta.1' });
  await assert.rejects(readFile(path.join(fixture.dataDir, 'DO-NOT-RUN')), { code: 'ENOENT' });
});

test('archives reject traversal, links, duplicates, special headers and dependency trees', () => {
  const fixture = packageFiles();
  const valid = Object.entries(fixture.files).map(([name, bytes]) => ({ name: `package/${name}`, bytes }));
  for (const entry of [
    { name: 'package/../escape.js', bytes: 'bad' },
    { name: '/escape.js', bytes: 'bad' },
    { name: 'package/dist/link.js', type: '2', link: '/etc/passwd' },
    { name: 'package/dist/link.js', type: '1', link: 'package/dist/visualizer.js' },
    { name: 'package/pax', type: 'x', bytes: 'path=../escape' },
    { name: 'package/fifo', type: '6' },
    { name: 'package/node_modules/evil.js', bytes: 'bad' },
    valid[0],
  ]) assert.throws(() => readPackageArchive(tar([...valid, entry]), 'synthetic-c4@1.0.0'));
  assert.throws(() => readPackageArchive(archive(fixture.files), 'other@1.0.0'), /identity/);
  const dependencies = { ...fixture.files, 'package.json': Buffer.from(JSON.stringify({
    name: 'synthetic-c4', version: '1.0.0', dependencies: { evil: '*' },
  })) };
  assert.throws(() => readPackageArchive(archive(dependencies), 'synthetic-c4@1.0.0'), /dependencies/);
  const corrupted = tar(valid); corrupted[0] ^= 1;
  assert.throws(() => readPackageArchive(corrupted, 'synthetic-c4@1.0.0'), /checksum/);
});

test('hashed analysis profiles require declared capability and an explicit profile grant', async t => {
  const fixture = await localPackage(t, {
    extra: { 'profiles/c4.json': Buffer.from(JSON.stringify(profile)) },
    manifest: { decisionProfiles: ['profiles/c4.json'], capabilities: ['model.read', 'analysis.request'] },
  });
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const row = await registry.install(fixture.directory);
  const loaded = await registry.getAssets(row.id);
  assert.equal(loaded.profiles[0].namespace, 'example.c4.architecture');
  await assert.rejects(registry.grant(row.id, {
    digest: row.digest, fields: ['entities'], history: false, approved: true, profiles: ['unknown'],
  }), /unrequested_profile/);
  const grant = await registry.grant(row.id, {
    digest: row.digest, fields: ['entities'], history: false, approved: true, profiles: ['architecture'],
  });
  assert.deepEqual(grant.profiles, ['architecture']);
  await assert.rejects(registry.grant(row.id, {
    digest: row.digest, fields: ['activity'], history: false, approved: true,
  }), /unrequested_data/);
  await assert.rejects(registry.grant(row.id, {
    digest: row.digest, fields: ['entities'], history: true, approved: true,
  }), /unrequested_history/);
});

test('catalogue exposes validated grouping profiles before approval and follows the installed digest', async t => {
  const manifest = { decisionProfiles: ['grouping.json'], capabilities: ['model.read', 'analysis.request'] };
  const fixture = await localPackage(t, { manifest,
    extra: { 'grouping.json': Buffer.from(JSON.stringify(profile)) },
  });
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const installed = await registry.install(fixture.directory);
  const [row] = await registry.list();
  const expected = [{ ...profile, namespace: `${installed.id}.${profile.id}` }];
  assert.deepEqual(row.profiles, expected);
  assert.deepEqual(installed.profiles, expected);
  assert.equal(row.grant, null);
  assert.deepEqual(Object.keys(row).sort(), ['development', 'digest', 'grant', 'id', 'manifest', 'profiles', 'version']);
  row.profiles[0].questions[0].question = 'Caller mutation';
  assert.deepEqual((await registry.list())[0].profiles, expected);
  await registry.grant(row.id, {
    digest: row.digest, fields: ['entities'], history: false, approved: true, profiles: [profile.id],
  });
  const nextProfile = { ...profile, id: 'next-architecture' };
  const next = packageFiles({ version: '1.0.1', manifest,
    extra: { 'grouping.json': Buffer.from(JSON.stringify(nextProfile)) },
  });
  for (const [name, bytes] of Object.entries(next.files)) await writeFile(path.join(fixture.directory, name), bytes);
  await registry.install(fixture.directory);
  const [updated] = await registry.list();
  assert.notEqual(updated.digest, row.digest);
  assert.equal(updated.grant, null);
  assert.deepEqual(updated.profiles, [{ ...nextProfile, namespace: `${row.id}.${nextProfile.id}` }]);
  const stored = path.join(fixture.dataDir, 'extensions/bundles', updated.id, updated.version, updated.digest, 'grouping.json');
  await chmod(stored, 0o600);
  await writeFile(stored, JSON.stringify(profile));
  await assert.rejects(registry.list(), /integrity/);
});

test('CLI delegates list/add/remove/doctor/dev and explicit dev never accepts a package spec', async t => {
  const fixture = await localPackage(t);
  const registry = await createExtensionRegistry({ dataDir: fixture.dataDir, projectId: PROJECT });
  const context = { registry, projectRoot: fixture.root, output: null };
  await runExtensions(['add', './package'], context);
  assert.equal((await runExtensions(['list'], context)).length, 1);
  assert.equal((await runExtensions(['doctor'], context)).ok, true);
  const dev = await runExtensions(['dev', './package'], context);
  assert.equal(dev.development, true);
  await assert.rejects(runExtensions(['dev', 'synthetic-c4@1.0.0'], context), /directory_required/);
  await runExtensions(['remove', fixture.manifest.id], context);
  assert.deepEqual(await registry.list(), []);
});
