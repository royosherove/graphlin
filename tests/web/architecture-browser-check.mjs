// Explicit browser integration check: real capture, parser, neutral decision
// service, domain analysis and model stream. No boundary records are seeded.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../runtime/daemon/server.mjs';
import { architectureSources, createArchitectureProvider } from '../helpers/architecture-fixture.mjs';

const applicationSource = architectureSources['main.js'];
const componentSource = architectureSources['orders.js'];
const addedComponentSource = [
  'export function receipts(request, response) {',
  "  response.end('Synthetic receipt response');",
  '}',
].join('\n');
const updatedApplicationSource = applicationSource
  .replace("import { orders } from './orders.js';",
    "import { orders } from './orders.js';\nimport { receipts } from './receipts.js';")
  .replace('createServer(orders)',
    "createServer((request, response) => request.url === '/receipt' ? receipts(request, response) : orders(request, response))");
const control = createArchitectureProvider();
const { provider } = control;
control.setRole(updatedApplicationSource, 'application');
control.setRole(addedComponentSource, 'component');
const architecture = model => model.interpretations.filter(value =>
  value.namespace === 'graphlin.architecture' && value.validity === 'current' &&
  value.classification === 'accepted' && value.support === 'supported');
const sourceRuns = () => provider.calls.filter(call => call.request.questions.kind).length;
async function until(read, label) {
  const deadline = Date.now() + 20000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

const require = createRequire(process.env.GRAPHLIN_BROWSER_DEPENDENCIES
  ? path.join(process.env.GRAPHLIN_BROWSER_DEPENDENCIES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const artifacts = path.resolve(process.env.GRAPHLIN_BROWSER_ARTIFACTS || '/tmp/graphlin-architecture-browser-check');
await mkdir(artifacts, { recursive: true });
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'graphlin-architecture-browser-')));
const projectRoot = path.join(directory, 'Synthetic orders'), dataDir = path.join(directory, 'state');
let server, browser, page;
const errors = [], requests = [], failedResponses = [], checkpoints = [];
try {
  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(path.join(projectRoot, 'main.js'), applicationSource);
  await writeFile(path.join(projectRoot, 'orders.js'), componentSource);
  server = await startServer({ projectRoot, dataDir, port: 0,
    policy: { transmitSource: true, displayEvidence: true }, decisionProvider: provider });
  const state = () => server.pipeline.getModelState();
  await until(() => architecture(state()).some(value => value.kind === 'architecture_membership'), 'automatic source discovery');
  const initial = state(), initialRecords = architecture(initial);
  assert.equal(initialRecords.filter(value => value.kind === 'application').length, 1);
  assert.equal(initialRecords.filter(value => value.kind === 'component').length, 1);
  assert.ok(sourceRuns() >= 2, 'automatic discovery analyzed captured source before any browser request');
  const application = initialRecords.find(value => value.kind === 'application');
  const component = initialRecords.find(value => value.kind === 'component');
  assert.deepEqual(new Set(initialRecords.find(value => value.kind === 'architecture_membership').entityIds),
    new Set([...application.entityIds, ...component.entityIds]));
  assert.ok(initialRecords.every(value => value.sourceRefs.length && value.entityIds.length <= 2));
  console.log('Automatic source scan produced the application, component and membership.');

  browser = await chromium.launch({ headless: true,
    ...(process.env.GRAPHLIN_BROWSER_EXECUTABLE ? { executablePath: process.env.GRAPHLIN_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    const route = new URL(request.url()).pathname;
    // Do not retain the authentication exchange or launch-token fragment.
    if (route !== '/api/auth') requests.push({ route, method: request.method(), body: request.postData() });
  });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ route: new URL(response.url()).pathname, status: response.status() });
  });
  const selectView = value => page.getByRole('combobox', { name: 'Visualizer', exact: true }).selectOption(value);
  const status = page.locator('#architecture-status');
  const group = label => page.locator('.diagram-group').filter({ has: page.locator('.group-heading', { hasText: label }) });
  const toggle = (verb, label) => page.getByRole('button', { name: `${verb} ${label}`, exact: true });
  const shot = name => page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
  async function assertNested(parent, child) {
    const outer = await group(parent).locator('.group-frame').boundingBox();
    const inner = await group(child).locator('.group-frame').boundingBox();
    assert.ok(outer && inner);
    assert.ok(inner.x > outer.x && inner.y > outer.y &&
      inner.x + inner.width < outer.x + outer.width && inner.y + inner.height < outer.y + outer.height,
    'the rendered component frame is inside its application frame');
  }
  await page.goto(server.url);
  await selectView('graphlin.c4');
  await toggle('Collapse', application.label).waitFor();
  await toggle('Expand', component.label).waitFor();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await assertNested(application.label, component.label);
  await shot('automatic-applications');
  assert.equal(requests.some(value => value.route === '/api/architecture/discover'), false);
  assert.equal(requests.some(value => value.route === '/api/extensions/analysis' || value.route === '/api/extensions/grant'), false);

  const beforeManual = sourceRuns();
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/architecture/discover');
  await page.getByRole('button', { name: 'Discover architecture', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 202);
  assert.deepEqual(JSON.parse(response.request().postData()), {});
  await until(() => sourceRuns() > beforeManual, 'manual source reanalysis');
  await until(() => server.pipeline.getArchitectureStatus().status === 'complete', 'manual discovery completion');
  await until(async () => (await status.innerText()).includes('complete'), 'visible manual completion');
  await shot('manual-discovery');
  console.log('Discover architecture sent an authenticated empty POST and reran source analysis.');

  await selectView('graphlin.changes');
  await page.getByRole('button', { name: 'Set baseline now', exact: true }).click();
  await page.locator('#model-position option', { hasText: 'Task baseline' }).waitFor({ state: 'attached' });
  checkpoints.push(...state().checkpoints);
  await selectView('graphlin.c4');
  await page.getByRole('checkbox', { name: 'Follow agent', exact: true }).uncheck();
  const beforeIncremental = state(), beforeIncrementalRuns = sourceRuns();
  await writeFile(path.join(projectRoot, 'receipts.js'), addedComponentSource);
  await writeFile(path.join(projectRoot, 'main.js'), updatedApplicationSource);
  await until(() => architecture(state()).filter(value => value.kind === 'component').length === 2 &&
    architecture(state()).filter(value => value.kind === 'architecture_membership').length === 2, 'incremental domain output');
  const incremental = state(), incrementalRecords = architecture(incremental);
  const added = incrementalRecords.find(value => value.kind === 'component' && value.id !== component.id);
  assert.ok(incremental.revision > beforeIncremental.revision);
  assert.ok(sourceRuns() > beforeIncrementalRuns);
  assert.ok(incrementalRecords.find(value => value.id === application.id).sourceRefs.some(ref =>
    application.sourceRefs.every(old => old.hash !== ref.hash)), 'the application interpretation uses the edited source version');
  await toggle('Expand', added.label).waitFor({ timeout: 20000 });
  await until(async () => (await status.innerText()).includes('2 components'), 'updated discovery counts');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await assertNested(application.label, component.label);
  await assertNested(application.label, added.label);
  await shot('incremental-applications');
  assert.equal(requests.filter(value => value.route === '/api/architecture/discover').length, 1);
  assert.ok(requests.some(value => value.route === '/api/model/v1/events'));
  console.log('The automatic rescan added a nested component through the live model stream.');

  await page.setViewportSize({ width: 760, height: 650 });
  await toggle('Expand', added.label).press('Enter');
  await toggle('Collapse', added.label).waitFor();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await assertNested(application.label, added.label);
  await shot('incremental-expanded-small');
  await toggle('Collapse', added.label).press('Space');
  await toggle('Expand', added.label).waitFor();
  await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption({ label: 'Task baseline' });
  await until(async () => (await status.innerText()).includes('Recorded architecture'), 'replay status');
  assert.equal(await page.getByRole('button', { name: 'Discover architecture', exact: true }).isEnabled(), false);
  const polls = requests.filter(value => value.route === '/api/architecture').length;
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(requests.filter(value => value.route === '/api/architecture').length, polls, 'replay stops status polling');
  assert.equal(await toggle('Expand', added.label).count(), 0, 'replay retains the pre-edit domain snapshot');
  await shot('replay-small');
  assert.equal(requests.some(value => value.route === '/api/extensions/analysis' || value.route === '/api/extensions/grant'), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedResponses, []);
  await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify({
    checks: ['automatic captured-source discovery before browser mount', 'nested default application/component frames',
      'explicit authenticated manual POST {} returns 202 and reruns analysis', 'automatic incremental source rescan',
      'new domain membership arrives through model SSE', 'narrow viewport keyboard expansion/collapse',
      'replay disables discovery and status polling', 'no extension grants or analysis requests'],
    initialRevision: initial.revision, incrementalRevision: incremental.revision,
    initialKinds: initialRecords.map(value => value.kind), incrementalKinds: incrementalRecords.map(value => value.kind),
    sourceAnalysisRuns: sourceRuns(), manualRequests: 1, checkpointCount: checkpoints.length,
    pageErrors: errors, failedResponses, seededInterpretations: false,
  }, null, 2));
  await Promise.all(['failure.png', 'failure.txt'].map(name => rm(path.join(artifacts, name), { force: true })));
  console.log(`Architecture browser checks passed. Artifacts: ${artifacts}`);
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    await writeFile(path.join(artifacts, 'failure.txt'), `${error.stack}\n${errors.join('\n')}\n${JSON.stringify(failedResponses)}\n${await page.locator('body').innerText()}`);
  } else {
    await writeFile(path.join(artifacts, 'failure.txt'), `${error.stack}\n${JSON.stringify(server?.pipeline.getArchitectureStatus?.())}`);
  }
  process.exitCode = 1;
} finally {
  control.releaseAll();
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
