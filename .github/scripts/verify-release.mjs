import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPackageFiles, validatePackage } from '../../scripts/validate-packages.mjs';

export function verifyReleaseContext({ repository, isPrivate, enabled, event, ref }, metadata) {
  assert.equal(repository, 'royosherove/graphlin', 'Releases are restricted to royosherove/graphlin.');
  assert.equal(isPrivate, false, 'Public npm release is blocked while the GitHub repository is private.');
  assert.equal(enabled, 'true', 'Set NPM_PUBLISH_ENABLED=true only after completing docs/releasing.md.');
  assert.equal(event, 'push', 'Only a pushed release tag can publish.');
  assert.match(metadata.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    'Only stable semantic versions are released by this workflow.');
  assert.equal(ref, `refs/tags/v${metadata.version}`, 'The tag must exactly match v<package.json version>.');
  assert.equal(metadata.private, false, 'Set package.json private:false only when public release is authorized.');
  assert.equal(metadata.name, 'graphlin');
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
    await publicPackageFiles(root);
    await validatePackage(root);
    process.stdout.write('Graphlin release repository, tag, package metadata, and contents verified.\n');
  } catch (error) {
    // Do not print event data, environment values, or local filesystem details.
    process.stderr.write(error.code === 'ERR_ASSERTION' ? `${error.message.split('\n')[0]}\n`
      : 'Graphlin release verification failed. Run this in the configured tag workflow.\n');
    process.exitCode = 1;
  }
}
