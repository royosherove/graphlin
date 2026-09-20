import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Query public metadata without npm configuration, credentials, or redirects.
// Only a well-formed registry response can authorize a publish attempt.
export async function shouldPublishVersion(metadata, fetchRegistry = fetch) {
  assert.equal(metadata.name, 'graphlin');
  assert.match(metadata.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  const response = await fetchRegistry('https://registry.npmjs.org/graphlin', {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.status === 200 || response.status === 404, 'npm registry lookup failed.');
  assert.match(response.headers.get('content-type') || '', /^application\/json(?:;|$)/i,
    'npm registry returned an unexpected content type.');
  const document = await response.json();
  assert.ok(document && typeof document === 'object' && !Array.isArray(document),
    'npm registry returned invalid metadata.');
  if (response.status === 404) {
    assert.equal(document.error, 'Not found', 'npm registry did not confirm package absence.');
    assert.ok(!document.time?.unpublished, 'An unpublished package needs maintainer review.');
    return true;
  }
  assert.equal(document.error, undefined, 'npm registry returned an error.');
  assert.equal(document.name, metadata.name, 'npm registry returned a different package.');
  assert.ok(document.versions && typeof document.versions === 'object' && !Array.isArray(document.versions),
    'npm registry returned invalid versions.');
  if (Object.hasOwn(document.versions, metadata.version)) {
    const published = document.versions[metadata.version];
    assert.equal(published?.name, metadata.name, 'npm registry returned invalid version metadata.');
    assert.equal(published?.version, metadata.version, 'npm registry returned invalid version metadata.');
    return false;
  }
  assert.ok(!document.time?.unpublished && !Object.hasOwn(document.time || {}, metadata.version),
    'A previously unpublished version cannot be reused.');
  return true;
}

export async function writePublishDecision(metadata, outputPath, fetchRegistry = fetch) {
  // Do not write an output on lookup failure. The workflow requires literal true.
  const publish = await shouldPublishVersion(metadata, fetchRegistry);
  await appendFile(outputPath, `publish=${publish}\n`);
  return publish;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const publish = await writePublishDecision(metadata, process.env.GITHUB_OUTPUT);
    process.stdout.write(publish
      ? 'Graphlin version is absent; publication may proceed after the release gates.\n'
      : 'Graphlin version is already published; nothing to publish.\n');
  } catch {
    // Registry bodies and exceptions may contain untrusted text; never echo them.
    process.stderr.write('Graphlin registry lookup failed; publication is blocked. Retry after resolving the registry error.\n');
    process.exitCode = 1;
  }
}
