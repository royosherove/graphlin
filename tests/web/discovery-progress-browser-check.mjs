// Explicit browser check, outside node --test:
// GRAPHLIN_BROWSER_DEPENDENCIES=/path/to/node-dependencies \
//   node tests/web/discovery-progress-browser-check.mjs
// Actual temporary daemon, inventory, parsing, analysis and authenticated UI.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDiscoveryProgressFixture, WITHHELD_SENTINEL } from './discovery-progress-daemon-fixture.mjs';

const require = createRequire(process.env.GRAPHLIN_BROWSER_DEPENDENCIES
  ? path.join(process.env.GRAPHLIN_BROWSER_DEPENDENCIES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const artifacts = path.resolve(process.env.GRAPHLIN_BROWSER_ARTIFACTS || '/tmp/graphlin-discovery-progress-check');
await mkdir(artifacts, { recursive: true });
const checks = [], errors = [], failedResponses = [], outbound = [], screenshots = [], cameras = [], posts = [];
const responses = new Set(), architectureRequests = new Set();
let browser, fixture, page, phase = 'startup', architectureRequestCount = 0, peakArchitectureRequests = 0;
let leaked = false;

async function until(read, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}
async function bounded(promise, label, timeout = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.GRAPHLIN_BROWSER_EXECUTABLE ? { executablePath: process.env.GRAPHLIN_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  fixture = await createDiscoveryProgressFixture();
  const [name, value] = fixture.cookie.split('=');
  await context.addCookies([{ name, value, url: fixture.origin, httpOnly: true, sameSite: 'Strict' }]);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin && !['data:', 'blob:'].includes(url.protocol)) {
      outbound.push(url.origin); return route.abort();
    }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: new Date() });
  const recordError = text => { if (!errors.includes(text)) errors.push(text); };
  page.on('pageerror', error => recordError(error.message));
  page.on('console', message => { if (message.type() === 'error') recordError(message.text()); });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST') posts.push(pathname);
    if (pathname === '/api/architecture') {
      architectureRequestCount++;
      architectureRequests.add(request);
      peakArchitectureRequests = Math.max(peakArchitectureRequests, architectureRequests.size);
    }
  });
  page.on('requestfinished', request => architectureRequests.delete(request));
  page.on('requestfailed', request => architectureRequests.delete(request));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 400) failedResponses.push({ path: pathname, status: response.status() });
    // Inspect only ordinary JSON from our synthetic daemon; never retain auth
    // material, headers, evidence text, or an unbounded SSE response body.
    if (!pathname.startsWith('/api/') || pathname.endsWith('/events') || pathname === '/api/auth') return;
    const task = response.text().then(text => { leaked ||= text.includes(WITHHELD_SENTINEL); }).catch(() => {});
    responses.add(task); task.finally(() => responses.delete(task));
  });
  await page.addInitScript(() => {
    const NativeStream = window.EventSource, streams = [], timers = new Map();
    const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    const probe = window.__discoveryBrowserCheck = { snapshots: 0, model: null, discovery: null };
    // Observe real timers and streams. No snapshot or progress state is seeded.
    window.setTimeout = (callback, milliseconds, ...args) => {
      if (typeof callback !== 'function') return nativeSet(callback, milliseconds, ...args);
      const stack = new Error().stack || '';
      const owner = stack.includes('/discovery-progress.js') ? 'panel'
        : stack.includes('/platform.js') ? 'platform' : null;
      const id = nativeSet((...values) => { timers.delete(id); callback(...values); }, milliseconds, ...args);
      if (owner) timers.set(id, owner);
      return id;
    };
    window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
    window.EventSource = class extends NativeStream {
      constructor(url, options) {
        super(url, options); streams.push(this);
        const pathname = new URL(url, location.href).pathname;
        if (pathname === '/api/events') {
          this.addEventListener('snapshot', event => { probe.discovery = JSON.parse(event.data).discovery; });
        }
        if (pathname === '/api/model/v1/events') {
          this.addEventListener('snapshot', event => {
            const model = JSON.parse(event.data);
            probe.snapshots++;
            probe.model = { projectId: model.projectId, sequence: model.sequence, coverage: model.coverage };
          });
        }
      }
    };
    probe.resources = () => ({
      panelTimers: [...timers.values()].filter(value => value === 'panel').length,
      platformTimers: [...timers.values()].filter(value => value === 'platform').length,
      openStreams: streams.filter(stream => stream.readyState !== NativeStream.CLOSED).length,
    });
  });

  const panel = page.locator('#discovery-progress');
  const detail = index => page.locator(`#discovery-stage-${index}-detail`);
  async function honestProgress() {
    assert.doesNotMatch(await panel.innerText(), /\b\d+(?:\.\d+)?%|\b\d+\s*(?:seconds?|minutes?)\s+(?:left|remaining)\b/i);
    assert.equal(await page.locator('#discovery-meter').getAttribute('aria-valuenow'), null);
    assert.equal(await panel.innerText().then(text => text.includes(WITHHELD_SENTINEL)), false);
  }
  async function shot(name) {
    const filename = path.join(artifacts, `${name}.png`);
    await page.screenshot({ path: filename, fullPage: true,
      mask: [page.locator('#project-path')], maskColor: '#e9edf1' });
    screenshots.push(filename);
    console.log(`Screenshot: ${filename}`);
  }
  async function camera(label) {
    const viewBox = await page.locator('#architecture').getAttribute('viewBox');
    cameras.push({ label, viewBox });
    return viewBox;
  }
  async function expand(label) {
    const expand = page.getByRole('button', { name: `Expand ${label}`, exact: true });
    if (await expand.count()) {
      await page.getByRole('button', { name: 'Fit', exact: true }).click();
      await expand.press('Enter');
    }
  }

  await page.goto(fixture.origin);
  await page.waitForFunction(() => window.__discoveryBrowserCheck.model !== null);
  await page.waitForFunction(() => /^\d+\.\d+\.\d+/.test(document.querySelector('#graphlin-version').textContent));
  const version = await page.locator('#graphlin-version').textContent();
  assert.equal(await page.locator('#visualizer').inputValue(), 'graphlin.blocks');
  // Keep incoming metadata from opening the large synthetic notes scope.
  await page.getByRole('checkbox', { name: 'Follow agent', exact: true }).uncheck();
  await page.locator('#discovery-details').waitFor({ state: 'visible' });
  assert.equal((await fixture.request('/api/state')).data.discovery.inventory.status, 'scanning',
    'the authoritative inventory API still reports another slice');
  assert.match(await detail(0).textContent(), /unknown|scanning|incomplete/i);
  await honestProgress();
  await shot('01-initial-unknown-total');
  checks.push('Initial bounded inventory reports an unknown total without a percentage or ETA');

  phase = 'active work with complete inventory';
  await bounded(fixture.initialGate.started, 'held real architecture evaluation');
  await page.waitForFunction(() => window.__discoveryBrowserCheck.discovery?.inventory.status === 'complete'
    && window.__discoveryBrowserCheck.discovery.initialCaptureComplete === true);
  await until(async () => await page.locator('#discovery-stage-0').getAttribute('data-state') === 'settled',
    'complete inventory in the panel');
  await until(async () => await page.locator('#discovery-stage-2').getAttribute('data-state') === 'active',
    'active architecture stage');
  assert.equal(fixture.initialGate.released, false);
  assert.ok(fixture.architecture().pending > 0);
  const notes = page.getByRole('button', { name: 'Collapse notes', exact: true });
  if (await notes.count()) await notes.press('Enter');
  await expand('app');
  await expand('orders.js');
  await expand('OrderBook');
  await page.getByRole('checkbox', { name: 'Follow agent', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  assert.match(await page.locator('#discovery-elapsed').textContent(), /Tracking for/);
  await honestProgress();
  await shot('02-active-known-work');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const manualCamera = await camera('manual camera during discovery');
  checks.push('A held normal decision-service evaluation shows active work after file inventory has settled');

  phase = 'ready and automatic collapse';
  fixture.initialGate.release();
  await bounded(fixture.server.pipeline.whenIdle(), 'discovery completion');
  await until(() => fixture.architecture().status === 'complete' && fixture.architecture().components > 0,
    'actual admitted component analysis');
  await until(async () => /Map ready/i.test(await page.locator('#discovery-title').textContent()), 'ready summary');
  await page.clock.fastForward(6000);
  await until(async () => !(await page.locator('#discovery-details').isVisible()), 'automatic collapse');
  assert.equal(await page.locator('#discovery-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await camera('automatically collapsed'), manualCamera);
  await honestProgress();
  await shot('03-ready-collapsed');
  await page.locator('#discovery-toggle').click();
  await page.locator('#discovery-details').waitFor({ state: 'visible' });
  assert.equal(await camera('manually reopened'), manualCamera);
  await shot('04-ready-reopened');
  checks.push('Settled discovery collapses, reopens on request, and preserves the manual camera with Follow off');

  phase = 'locally withheld source remains partial';
  await fixture.withholdSettings();
  await bounded(fixture.server.pipeline.whenIdle(), 'withheld-source reconciliation');
  await until(() => fixture.architecture().withheld > 0, 'safe withheld aggregate');
  const status = await fixture.request('/api/architecture');
  assert.equal(status.status, 200);
  assert.equal(status.data.status, 'partial');
  assert.ok(status.data.withheld > 0);
  await page.locator('#visualizer').selectOption('graphlin.c4');
  await page.locator('#c4-level').selectOption('components');
  await until(async () => /withheld|privacy/i.test(await page.locator('#architecture-status').textContent()),
    'C4 privacy-limited status');
  await until(async () => /withheld|privacy/i.test(await panel.innerText()), 'visible privacy-limited progress');
  assert.doesNotMatch(await page.locator('#discovery-title').textContent(), /Map ready/i);
  await honestProgress();
  await expand('orders.js');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await shot('05-private-source-withheld-c4');
  checks.push('Real locally withheld synthetic source reports partial discovery in C4 without exposing its value');

  phase = 'manual collapse survives further background work';
  await page.locator('#visualizer').selectOption('graphlin.blocks');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const backgroundCamera = await camera('manual Blocks camera after returning from C4');
  if (await page.locator('#discovery-details').isVisible()) await page.locator('#discovery-toggle').click();
  await fixture.restoreSettings();
  await bounded(fixture.server.pipeline.whenIdle(), 'restored synthetic source');
  await until(() => fixture.architecture().status === 'complete', 'current analysis after restoration');
  await page.clock.fastForward(6000);
  assert.equal(await page.locator('#discovery-details').isVisible(), false);
  assert.equal(await camera('background update while collapsed'), backgroundCamera);
  checks.push('A user-collapsed panel stays collapsed during later source updates');

  phase = 'timer and request cleanup';
  await until(() => architectureRequests.size === 0, 'settled architecture status request');
  await until(async () => {
    const resources = await page.evaluate(() => window.__discoveryBrowserCheck.resources());
    return resources.panelTimers > 0 && resources.platformTimers > 0;
  }, 'observable panel and status timers');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const resourceState = await page.evaluate(() => window.__discoveryBrowserCheck.resources());
  assert.deepEqual(resourceState, { panelTimers: 0, platformTimers: 0, openStreams: 0 });
  const requestCount = architectureRequestCount;
  const elapsed = await page.locator('#discovery-elapsed').textContent();
  await page.clock.fastForward(15_000);
  assert.equal(architectureRequestCount, requestCount);
  assert.equal(await page.locator('#discovery-elapsed').textContent(), elapsed);
  assert.ok(peakArchitectureRequests <= 1, 'the panel and C4 share one architecture status request at a time');
  checks.push('Pagehide clears panel/platform timers and event streams and stops further status requests');

  await Promise.all([...responses]);
  assert.equal(leaked, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(outbound, []);
  assert.deepEqual(posts, [], 'viewing progress and C4 must never start discovery with a POST');
  const report = {
    version, checks, screenshots, cameras, pageErrors: errors, failedResponses, outboundOrigins: outbound,
    architectureRequestCount, peakArchitectureRequests, posts, cleanup: resourceState,
    realInventory: true, realParser: true, realDecisionService: true, syntheticProviderHeldForScreenshots: true,
    providerCalls: fixture.providerCalls.length, seededProgress: false, privateValueDisclosed: leaked,
  };
  await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2));
  await Promise.all(['failure.png', 'failure.json'].map(name => rm(path.join(artifacts, name), { force: true })));
  console.log(`Discovery progress browser checks passed (${checks.length}). Artifacts: ${artifacts}`);
} catch (error) {
  console.error(`${phase}: ${error.stack}`);
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'),
    mask: [page.locator('#project-path')], maskColor: '#e9edf1', timeout: 5000 }).catch(() => {});
  await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({
    phase, error: error.stack, checks, pageErrors: errors, failedResponses, outboundOrigins: outbound, cameras,
    architecture: fixture?.architecture(),
    panel: await page?.locator('#discovery-progress').innerText().catch(() => null),
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  finally { await fixture?.close(); }
}
