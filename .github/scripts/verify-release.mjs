import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPackageFiles, validatePackage } from '../../scripts/validate-packages.mjs';

export function verifyReleaseContext({ repository, isPrivate, enabled, event, ref }, metadata) {
  assert.equal(repository, 'royosherove/graphlin', 'Releases are restricted to royosherove/graphlin.');
  assert.equal(isPrivate, false, 'Public npm release is blocked while the GitHub repository is private.');
  assert.equal(enabled, 'true', 'Set NPM_PUBLISH_ENABLED=true only after completing docs/releasing.md.');
  assert.ok(event === 'push' || event === 'workflow_dispatch', 'Only a main push or manual dispatch can publish.');
  assert.match(metadata.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    'Only stable semantic versions are released by this workflow.');
  assert.equal(ref, 'refs/heads/main', 'Only refs/heads/main can publish; tags and other branches are blocked.');
  assert.equal(metadata.private, false, 'Set package.json private:false only when public release is authorized.');
  assert.equal(metadata.name, 'graphlin');
}

export function verifyReleaseVersions(metadata, manifests) {
  for (const filename of ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    assert.equal(manifests[filename]?.name, metadata.name, 'All release manifests must use the package name.');
    assert.equal(manifests[filename]?.version, metadata.version, 'All release manifests must use the package version.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    verifyReleaseContext({
      repository: process.env.GITHUB_REPOSITORY,
      isPrivate: event.repository?.private,
      enabled: process.env.NPM_PUBLISH_ENABLED,
      event: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
    }, metadata);
    const manifests = Object.fromEntries(await Promise.all(
      ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']
        .map(async filename => [filename, JSON.parse(await readFile(path.join(root, filename), 'utf8'))])));
    verifyReleaseVersions(metadata, manifests);
    await publicPackageFiles(root);
    await validatePackage(root);
    process.stdout.write('Graphlin release repository, main branch, package versions, and contents verified.\n');
  } catch (error) {
    // Do not print event data, environment values, or local filesystem details.
    process.stderr.write(error.code === 'ERR_ASSERTION' ? `${error.message.split('\n')[0]}\n`
      : 'Graphlin release verification failed. Run this in the configured main workflow.\n');
    process.exitCode = 1;
  }
}
