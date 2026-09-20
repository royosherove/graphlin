import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCandidates, createPolicy, EvidenceStore, metadataEvent,
} from '../../runtime/core/index.mjs';
import { hash, opaque } from '../../runtime/core/common.mjs';
import { createDecisionService } from '../../runtime/jev/index.mjs';
import { recordingTransport } from './helpers.mjs';

const policy = createPolicy({ transmitSource: true });
const event = metadataEvent({ kind: 'artifact.changed', id: 'privacy-boundary', incomplete: false });
const control = 'export function publicProbe() { return 1; }';
const sentinel = 'SYNTHETIC_BOUNDARY_VALUE_731';
function artifact(text, relativePath = 'src/settings.mjs') {
  return { id: opaque('artifact', relativePath), relativePath, hash: hash(text),
    generation: 1, status: 'present', exists: true, complete: true, text };
}
function select(artifacts, options = {}) {
  return buildCandidates({ event, policy, artifacts, ...options });
}

async function firstRequest(candidates, currentEvent = event) {
  // A local replacement records the actual serialized request and returns
  // permissive scripted answers. It never delegates to fetch or any network.
  const transport = recordingTransport();
  const service = createDecisionService({
    apiKey: 'synthetic-offline-transport-key',
    endpoint: 'http://127.0.0.1/v1/systemone', fetchImpl: transport.fetchImpl,
  });
  try {
    const decision = await service.classify({ event: currentEvent, candidates, policy });
    assert.equal(decision.status, 'accepted', JSON.stringify(decision.diagnostics));
    assert.equal(transport.calls.length, 2, 'normal A and B gates run for the harmless control');
    assert.ok(Object.hasOwn(transport.calls[0].request.questions, 'a_activity'));
    return transport.calls[0];
  } finally { service.close(); }
}

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'graphlin-privacy-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const [name, source] of [
  ['prefixed API key', `const TYPESAFE_API_KEY = "${sentinel}";`],
  ['camelCase password', `const databasePassword = "${sentinel}";`],
  ['leading underscore', `const _apiKey = '${sentinel}';`],
  ['multiple leading underscores', `const __serviceApiKey = "${sentinel}";`],
  ['prefixed AWS access secret', `const AWS_SECRET_ACCESS_KEY = "${sentinel}";`],
  ['prefixed AWS access key ID', `const AWS_ACCESS_KEY_ID = "${sentinel}";`],
  ['client secret', `const serviceClientSecret = "${sentinel}";`],
  ['refresh token', `const oauthRefreshToken = "${sentinel}";`],
  ['session token', `const appSessionToken = "${sentinel}";`],
  ['auth field', `const _auth = "${sentinel}";`],
  ['credential field', `const serviceCredential = "${sentinel}";`],
  ['private key', `const signingPrivateKey = "${sentinel}";`],
  ['passphrase', `const databasePassphrase = "${sentinel}";`],
  ['password abbreviation', `const DB_PWD = "${sentinel}";`],
  ['explicit value suffix', `const apiKeyValue = "${sentinel}";`],
  ['hyphenated JSON field', `const config = { "database-password": "${sentinel}" };`],
  ['camelCase object field', `const config = { databasePassword: "${sentinel}" };`],
  ['indexed object field', `config["apiKey"] = "${sentinel}";`],
  ['typed binding', `const apiKey: string = "${sentinel}";`],
  ['unquoted shell binding', `TYPESAFE_API_KEY=${sentinel}`],
  ['unquoted camelCase setting', `databasePassword: ${sentinel}`],
  ['template literal', 'const apiKey = `' + sentinel + '`;'],
  ['multiline literal', 'const apiKey = `\n' + sentinel + '\n`;'],
  ['short password', 'const databasePassword = "x";'],
  ['reference with literal fallback', `const apiKey = process.env.API_KEY || "${sentinel}";`],
  ['reference with nullish fallback', `const apiKey = process.env.API_KEY ?? "${sentinel}";`],
  ['continued reference with fallback', `const apiKey = process.env.API_KEY\n  || "${sentinel}";`],
  ['commented continuation with fallback', `const apiKey = process.env.API_KEY // reference only until next line\n  || "${sentinel}";`],
  ['block comment followed by fallback', `const apiKey = process.env.API_KEY /* reference */ || "${sentinel}";`],
  ['reference with literal suffix', `const apiKey = process.env.API_KEY + "${sentinel}";`],
  ['template with literal suffix', 'const apiKey = `${process.env.API_KEY}' + sentinel + '`;'],
  ['shell reference with default', 'API_KEY="${API_KEY:-' + sentinel + '}"'],
  ['Python reference with default', `databasePassword = os.getenv("DB_PASSWORD", "${sentinel}")`],
  ['empty string followed by literal fallback', `const apiKey = "" || "${sentinel}";`],
  ['two assignments on one line', `const apiKey = process.env.API_KEY; const databasePassword = "${sentinel}";`],
  ['secret binding in a comment', `// TYPESAFE_API_KEY="${sentinel}"`],
]) {
  test(`${name} never enters the first serialized Jev request`, async t => {
    const text = `${source}\nexport function configuredProbe() { return 1; }`;
    const selected = select([artifact(text), artifact(control, 'src/public.mjs')]);
    const first = await firstRequest(selected);
    assert.equal(first.options.body.includes(sentinel), false);
    assert.deepEqual(first.request.state.evidence.map(item => item.code), [control]);
    const root = await directory(t);
    await writeFile(path.join(root, 'settings.mjs'), text);
    const [captured] = await new EvidenceStore({ projectRoot: root, policy }).capture(['settings.mjs']);
    assert.equal(captured.text, null, 'capture also withholds the complete contaminated source');
  });
}

test('credential configuration is excluded before capture and the first serialized Jev request', async t => {
  const root = await directory(t);
  for (const filename of [
    '.npmrc', 'nested/.npmrc', 'nested/.NPMRC', '.npmrc.backup',
    '.pypirc', '.netrc', '_netrc', '.yarnrc', '.yarnrc.yml',
    '.git-credentials', '.gitconfig', '.dockercfg', '.docker/config.json', '.kube/config',
    '.config/gcloud/configurations/config_default', '.config/gh/hosts.yml',
    '.boto', '.s3cfg', '.pgpass', '.my.cnf', 'nested/pip.conf', 'nested/pip.ini',
    'NuGet.Config', 'nested/auth.json',
  ]) {
    await t.test(filename, async () => {
      // No secret-shaped key: exclusion must depend on the credential filename,
      // not on a recognizable token prefix, key name, or file syntax.
      const text = `fixture = ${sentinel}\n`;
      const first = await firstRequest(select([artifact(text, filename), artifact(control, 'src/public.mjs')]));
      assert.equal(first.options.body.includes(sentinel), false);
      assert.deepEqual(first.request.state.evidence.map(item => item.code), [control]);
      await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await writeFile(path.join(root, filename), text);
      const [captured] = await new EvidenceStore({ projectRoot: root, policy }).capture([filename]);
      assert.equal(captured.status, 'unavailable');
      assert.equal(captured.text, null);
      assert.equal(captured.hash, null, 'excluded content is not read for hashing');
    });
  }
});

for (const reference of [
  'const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;',
  'const databasePassword = process.env.DATABASE_PASSWORD;',
  'const _apiKey = process.env.API_KEY;',
  'const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;',
  'const API_KEY = process.env["API_KEY"];',
  "const apiKey = process.env[ 'API_KEY' ];",
  'const authToken = import.meta.env.AUTH_TOKEN;',
  'const authToken = import.meta.env["AUTH_TOKEN"];',
  'const apiKey = Bun.env.API_KEY;',
  'const apiKey = Deno.env.get("API_KEY");',
  'databasePassword = os.environ["DB_PASSWORD"]',
  'databasePassword = os.getenv("DB_PASSWORD")',
  'databasePassword = os.environ.get("DB_PASSWORD")',
  'API_KEY=$API_KEY',
  'API_KEY=${API_KEY}',
  'API_KEY="${API_KEY}"',
  "API_KEY='$API_KEY'",
  'const apiKey = `${process.env.API_KEY}`;',
  'const config = { databasePassword: process.env.DB_PASSWORD };',
  'config["apiKey"] = process.env.API_KEY;',
  'const apiKey: string | undefined = process.env.API_KEY;',
  'const apiKey = process.env.API_KEY',
  'const apiKey = process.env.API_KEY // a reference, followed by a new declaration',
  'const apiKey = process.env.API_KEY /* reference */;',
  'const apiKey = "";',
  'const databasePassword = null;',
  'const apiKey = undefined;',
  'const db = new Pool({ connectionString: process.env.DATABASE_URL });',
  'const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;',
]) {
  test(`safe configuration remains observable: ${reference}`, async t => {
    const text = `${reference}\n${control}`;
    const root = await directory(t);
    await writeFile(path.join(root, 'settings.mjs'), text);
    const [captured] = await new EvidenceStore({ projectRoot: root, policy }).capture(['settings.mjs']);
    assert.equal(captured.text, text);
    const first = await firstRequest(select([captured]));
    assert.deepEqual(first.request.state.evidence.map(item => item.code), [text]);
  });
}

test('secret-bearing public intent is withheld before the first request without withholding safe source', async () => {
  const currentEvent = metadataEvent({ kind: 'intent.observed', id: 'privacy-intent', incomplete: false });
  const candidates = [
    ...select([artifact(control, 'src/public.mjs')]),
    ...select([], { event: currentEvent,
      publicText: `Propose function configureClient() with databasePassword = "${sentinel}".` }),
  ];
  const first = await firstRequest(candidates, currentEvent);
  assert.deepEqual(first.request.state.evidence.map(item => item.code), [control]);
  assert.equal(first.options.body.includes(sentinel), false);
});

test('a credential-only observation produces no serialized request', async () => {
  const candidates = select([artifact(`const TYPESAFE_API_KEY = "${sentinel}";`)]);
  assert.deepEqual(candidates, []);
  const transport = recordingTransport();
  const service = createDecisionService({ apiKey: 'synthetic-offline-transport-key',
    endpoint: 'http://127.0.0.1/v1/systemone', fetchImpl: transport.fetchImpl });
  try {
    const decision = await service.classify({ event, candidates, policy });
    assert.equal(decision.diagnostics.code, 'no_candidates');
    assert.equal(transport.calls.length, 0);
  } finally { service.close(); }
});
