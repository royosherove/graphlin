import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { publicPackageFiles, validatePackage } from '../../scripts/validate-packages.mjs';

const exec = promisify(execFile);
const SOURCE = fileURLToPath(new URL('../../', import.meta.url));

export function assertPublicContents(contents) {
  assert.ok(!/(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+\/|[A-Z]:\\Users\\/i.test(contents),
    'Published files must not contain identifying machine paths.');
  assert.ok(!/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bnpm_[A-Za-z0-9]{30,}/.test(contents),
    'Published files must not contain credentials.');
  assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{32,}/.test(contents),
    'Published files must not contain private key material.');
}

export async function verifyNpmPack(root = SOURCE) {
  const expectedFiles = (await publicPackageFiles(root)).sort();
  await validatePackage(root);
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin npm verification '));
  try {
    // Run npm outside the project so its local .npmrc is never loaded, but
    // pack the actual source directory to verify exactly what npm would ship.
    const work = path.join(base, 'work');
    await mkdir(work);
    // Isolated configuration/cache: verification never needs login or network.
    const env = { PATH: process.env.PATH, HOME: path.join(base, 'home'),
      npm_config_userconfig: path.join(base, 'user.npmrc'),
      npm_config_globalconfig: path.join(base, 'global.npmrc'), npm_config_cache: path.join(base, 'cache'),
      npm_config_update_notifier: 'false', npm_config_offline: 'true',
      GRAPHLIN_DATA_DIR: path.join(base, 'state') };
    const runNpm = args => exec('npm', args, { cwd: work, env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const { stdout } = await runNpm(['pack', path.resolve(root), '--json', '--ignore-scripts', '--pack-destination', base]);
    const packed = JSON.parse(stdout);
    assert.equal(packed.length, 1);
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packed[0].filename, `graphlin-${metadata.version}.tgz`);
    assert.deepEqual(packed[0].files.map(file => file.path).sort(), expectedFiles,
      'npm tarball contents must exactly match the public file allowlist.');
    const tarball = path.join(base, packed[0].filename);
    assert.equal(`sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`, packed[0].integrity);
    // Publish prepares directory manifests differently from pack/install.
    // Exercise both paths with the actual npm CLI, without credentials,
    // network access, lifecycle scripts, or a registry write.
    for (const candidate of [path.resolve(root), tarball]) {
      const dryRun = await runNpm(['publish', candidate, '--dry-run', '--ignore-scripts', '--offline', '--json']);
      assert.doesNotMatch(dryRun.stderr, /auto-corrected|errors corrected|invalid and removed/i,
        'npm publish must preserve the reviewed manifest without corrections.');
      const report = JSON.parse(dryRun.stdout);
      // npm 11 keys publish JSON by package name; older supported CLIs
      // return the contents object directly.
      const contents = report[metadata.name] ?? report;
      assert.equal(contents.name, metadata.name);
      assert.equal(contents.version, metadata.version);
      assert.deepEqual(contents.files.map(file => file.path).sort(), expectedFiles);
    }
    const listing = await exec('tar', ['-tzf', tarball], { timeout: 15_000 });
    assert.deepEqual(listing.stdout.trim().split('\n').sort(), expectedFiles.map(file => `package/${file}`).sort());
    const unpacked = path.join(base, 'unpacked');
    await mkdir(unpacked);
    await exec('tar', ['-xzf', tarball, '-C', unpacked], { timeout: 15_000 });
    const packageRoot = path.join(unpacked, 'package');
    await validatePackage(packageRoot);
    for (const file of expectedFiles) {
      const contents = await readFile(path.join(packageRoot, file), 'utf8');
      assertPublicContents(contents);
      assert.equal(contents, await readFile(path.join(root, file), 'utf8'), 'Packed source must match the reviewed source.');
    }
    // npm publish uses the same fix operation before preparing a directory
    // manifest. Run it only on the disposable extraction and inspect its bin.
    await runNpm(['pkg', 'fix', '--prefix', packageRoot]);
    const normalized = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(normalized.bin, metadata.bin, 'npm normalization must preserve the CLI registry manifest.');
    assert.deepEqual(normalized.files, metadata.files, 'npm normalization must preserve the anchored allowlist.');
    const prefix = path.join(base, 'installed');
    await runNpm(['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit',
      '--no-fund', '--package-lock=false', tarball]);
    const bin = path.join(prefix, 'node_modules', '.bin', 'graphlin');
    const help = await exec(bin, ['--help'], { cwd: base, env, timeout: 15_000 });
    assert.match(help.stdout, /Graphlin/);
    const installed = path.join(prefix, 'node_modules', 'graphlin');
    await validatePackage(installed);
    const dataDir = path.join(base, 'stable data');
    // Only package preparation: no host detection, installation, saved key, or
    // personal host configuration. Import the actual npm-installed entry point.
    const smokeEnv = { PATH: process.env.PATH, GRAPHLIN_DATA_DIR: dataDir, GRAPHLIN_NODE: process.execPath };
    await exec(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const [installed, dataDir, version] = process.argv.slice(1);
      const { preparePackages } = await import(pathToFileURL(path.join(installed, 'scripts/onboarding.mjs')));
      const stable = await preparePackages(dataDir, version);
      assert.equal(stable, path.join(dataDir, 'plugins', 'graphlin', version));
    `, installed, dataDir, metadata.version], { cwd: work, env: smokeEnv, timeout: 20_000 });
    const stable = path.join(dataDir, 'plugins', 'graphlin', metadata.version);
    for (const host of ['claude', 'codex']) await validatePackage(path.join(stable, host, 'graphlin'));
    // Remove every disposable package source, including the tarball and npm
    // cache. Never remove the caller's checkout. A new process below has no
    // installed-module cache and must load the copied stable runtime from disk.
    for (const disposable of [prefix, unpacked, tarball, env.npm_config_cache]) {
      await rm(disposable, { recursive: true, force: true });
      await assert.rejects(lstat(disposable), { code: 'ENOENT' });
    }
    const smoke = await exec(process.execPath, [
      fileURLToPath(new URL('./smoke-stable-packages.mjs', import.meta.url)),
      stable, dataDir, path.join(base, 'synthetic projects'),
    ], { cwd: work, env: smokeEnv, timeout: 20_000, killSignal: 'SIGKILL' });
    const stablePlugins = JSON.parse(smoke.stdout);
    assert.deepEqual(stablePlugins, [
      { host: 'claude', sourceEvidence: true, hooks: 2 },
      { host: 'codex', sourceEvidence: true, hooks: 2 },
    ]);
    return { name: metadata.name, version: metadata.version, files: expectedFiles.length,
      publishDryRun: true, normalizedBin: normalized.bin,
      installedCli: true, temporaryInstallRemoved: true, stablePlugins };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await verifyNpmPack())}\n`); }
  catch { process.stderr.write('Graphlin npm tarball verification failed.\n'); process.exitCode = 1; }
}
