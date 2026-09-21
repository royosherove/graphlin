// Explicit integration command, intentionally outside node --test discovery:
// GRAPHLIN_BROWSER_DEPENDENCIES=/path/to/node-dependencies \
//   node tests/web/activity-browser-check.mjs
// Real daemon, parser, hook ingestion, decision-service evaluation and SSE.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createActivityDaemonFixture } from './activity-daemon-fixture.mjs';

const require = createRequire(process.env.GRAPHLIN_BROWSER_DEPENDENCIES
  ? path.join(process.env.GRAPHLIN_BROWSER_DEPENDENCIES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const artifacts = path.resolve(process.env.GRAPHLIN_BROWSER_ARTIFACTS || '/tmp/graphlin-activity-browser-check');
await mkdir(artifacts, { recursive: true });
const fixture = await createActivityDaemonFixture();
const checks = [], errors = [], failedResponses = [], outbound = [], cameras = [], failures = [];
let browser, page, phase = 'initial load';
async function until(read, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}
async function bounded(promise, label, timeout = 5000) {
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  const recordError = message => { if (!errors.includes(message)) errors.push(message); };
  page.on('pageerror', error => recordError(error.message));
  page.on('console', message => { if (message.type() === 'error') recordError(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  // Observe actual EventSource deliveries. The close method lets expiry be
  // tested with a silent transport, without injecting any model/activity data.
  await page.addInitScript(() => {
    const Native = window.EventSource, streams = [];
    const probe = window.__activityBrowserCheck = { deliveries: 0, modelDeliveries: 0, model: null };
    probe.silence = () => streams.forEach(stream => stream.close());
    window.EventSource = class extends Native {
      constructor(url, options) {
        super(url, options); streams.push(this);
        const path = new URL(url, location.href).pathname;
        this.addEventListener('snapshot', event => {
          probe.deliveries++;
          if (path === '/api/model/v1/events') {
            probe.modelDeliveries++;
            const model = JSON.parse(event.data);
            probe.model = { revision: model.revision, sequence: model.sequence,
              session: model.selection?.sessionId ?? null };
          }
        });
      }
    };
  });
  const entity = label => page.locator(`.diagram-node[aria-label^=${JSON.stringify(label + '.')}], .diagram-group[aria-label^=${JSON.stringify(label + '.')}]`);
  const badge = (label, operation, outcome) => entity(label).locator(
    `.tool-activity-badge[data-operation="${operation}"][data-outcome="${outcome}"]`);
  const current = (operation, outcome) => page.locator(
    `.current-activity-item[data-operation="${operation}"][data-outcome="${outcome}"]`);
  const shot = async name => {
    const filename = path.join(artifacts, `${name}.png`);
    await page.screenshot({ path: filename, fullPage: true,
      mask: [page.locator('#project-path')], maskColor: '#e9edf1' });
    console.log(`Screenshot: ${filename}`);
  };
  async function show(label, operation, outcome, text) {
    await badge(label, operation, outcome).waitFor({ state: 'visible' });
    assert.match(await badge(label, operation, outcome).textContent(), new RegExp(text));
  }
  async function expand(label) {
    const button = page.getByRole('button', { name: `Expand ${label}`, exact: true });
    if (await button.count()) await button.click();
    await page.getByRole('button', { name: `Collapse ${label}`, exact: true }).waitFor();
  }
  const payload = (hook_event_name, tool_name, tool_use_id, session_id = 'harbor-session', filename = 'app/orders.js') => ({
    hook_event_name, session_id, tool_name, tool_use_id,
    tool_input: { file_path: fixture.file(filename),
      ...(tool_name === 'Edit' ? { old_string: 'saved: true', new_string: "saved: true, status: 'ready'" } : {}) },
    ...(hook_event_name === 'PostToolUse' ? { tool_response: { success: true } } : {}),
    ...(hook_event_name === 'PostToolUseFailure' ? { error: 'Synthetic edit rejected' } : {}),
  });
  async function mapped(event, outcome = 'pending') {
    return until(() => fixture.rows(event).find(row => row.kind === 'activity.mapped' &&
      row.mapping === 'decision' && row.outcome === outcome), 'decision-mapped hook targets');
  }
  async function allOrderTargets(operation, outcome, text) {
    const selected = operation === 'read' ? 'loadOrders' : 'saveOrder';
    const unselected = operation === 'read' ? 'saveOrder' : 'loadOrders';
    for (const label of [selected, 'OrderBook', 'orders.js', 'app']) {
      await show(label, operation, outcome, text);
    }
    assert.equal(await badge(unselected, operation, outcome).count(), 0);
    assert.equal(await badge('formatOrder', operation, outcome).count(), 0,
      'an unselected sibling is not claimed as a semantic target');
  }
  async function silenceStreams() {
    return page.evaluate(() => {
      window.__activityBrowserCheck.silence();
      return window.__activityBrowserCheck.deliveries;
    });
  }
  async function verifySilent(count) {
    assert.equal(await page.evaluate(() => window.__activityBrowserCheck.deliveries), count,
      'expiry must not depend on a new SSE snapshot');
  }
  async function recordCamera(label) {
    const camera = await page.evaluate(() => ({
      viewBox: document.querySelector('#architecture').getAttribute('viewBox'),
      follow: document.querySelector('#follow-agent').checked,
      session: document.querySelector('#session').value,
      activityVisible: !document.querySelector('#current-activity').hidden,
      modelSession: window.__activityBrowserCheck.model?.session,
    }));
    cameras.push({ label, ...camera });
    return camera.viewBox;
  }

  await page.goto(fixture.origin);
  await page.waitForFunction(() => window.__activityBrowserCheck.model !== null);
  await page.waitForFunction(() => /^\d+\.\d+\.\d+/.test(document.querySelector('#graphlin-version').textContent));
  const viewerVersion = await page.locator('#graphlin-version').textContent();
  assert.equal(await page.locator('#visualizer').inputValue(), 'graphlin.blocks');
  await expand('app');
  await expand('orders.js');
  await expand('OrderBook');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  assert.equal(await page.locator('.tool-activity-badge').count(), 0);
  assert.equal(await page.locator('#current-activity').isVisible(), false);
  await shot('01-before-blocks');
  checks.push('Blocks is the initial view over parsed source, with no fabricated activity');

  const session = await fixture.startSession('harbor-session');
  await page.waitForFunction(session => document.querySelector('#session').value === session, session);
  phase = 'fast exact pending before provider response';
  const pendingGate = fixture.holdNextMapping();
  const started = Date.now();
  const pending = await fixture.hook(payload('PreToolUse', 'Read', 'slow-read'));
  const heldCall = await bounded(pendingGate.started, 'held target evaluation');
  await show('orders.js', 'read', 'pending', 'Reading');
  await show('app', 'read', 'pending', 'Reading');
  const pendingVisibleMs = Date.now() - started;
  assert.equal(pendingGate.released, false);
  assert.equal(fixture.rows(pending).at(-1).mapping, 'exact');
  assert.equal(fixture.rows(pending).at(-1).outcome, 'pending');
  assert.equal(await badge('loadOrders', 'read', 'pending').count(), 0);
  // Exceed the actual mapper deadline: exact feedback survives rubric tuning.
  await delay(Math.max(0, heldCall.deadlineAt + 150 - Date.now()));
  pendingGate.release();
  await fixture.pipeline.whenIdle();
  await show('orders.js', 'read', 'pending', 'Reading');
  assert.equal(fixture.rows(pending).some(row => row.mapping === 'decision'), false);
  await fixture.hook(payload('PostToolUse', 'Read', 'slow-read'));
  await show('orders.js', 'read', 'succeeded', 'Read');
  checks.push(`Exact Reading appeared before the held provider resolved (${pendingVisibleMs} ms), and survived mapping timeout`);

  phase = 'mapped read on every chosen symbol and ancestor';
  const read = await fixture.hook(payload('PreToolUse', 'Read', 'overlap-read'));
  const mapping = await mapped(read);
  const byId = new Map(fixture.model().entities.map(value => [value.id, value]));
  assert.ok(mapping.entityIds.some(id => byId.get(id)?.label === 'loadOrders'));
  assert.equal(mapping.entityIds.some(id => byId.get(id)?.label === 'saveOrder'), false);
  await allOrderTargets('read', 'pending', 'Reading');
  assert.equal(await badge('loadOrders', 'read', 'pending').locator('.eye-pupil').count(), 2);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await shot('02-reading-eyes');
  checks.push('Real service.evaluate answers enrich the read to loadOrders and every visible ancestor without selecting sibling methods');

  phase = 'overlapping read and edit';
  const edit = await fixture.hook(payload('PreToolUse', 'Edit', 'overlap-edit'));
  await mapped(edit);
  await allOrderTargets('edit', 'pending', 'Editing');
  await allOrderTargets('read', 'pending', 'Reading');
  assert.equal(await badge('saveOrder', 'edit', 'pending').locator('.tool-activity-icon path').count(), 1);
  await shot('03-editing-pen-overlap');
  await fixture.hook(payload('PostToolUse', 'Read', 'overlap-read', 'unrelated-session'));
  await fixture.pipeline.whenIdle();
  assert.equal(fixture.pipeline.getState().sessionId, session);
  await allOrderTargets('read', 'pending', 'Reading');
  await allOrderTargets('edit', 'pending', 'Editing');
  await fixture.hook(payload('PostToolUse', 'Read', 'overlap-read'));
  await allOrderTargets('read', 'succeeded', 'Read');
  await allOrderTargets('edit', 'pending', 'Editing');
  checks.push('Overlapping calls stay distinct; a different session completion cannot end the active read or edit');

  phase = 'actual source edit and distinct failure';
  const changedSourceGate = fixture.holdNextMapping();
  try {
    await fixture.editOrders();
    await fixture.hook(payload('PostToolUse', 'Edit', 'overlap-edit'));
    await bounded(changedSourceGate.started, 'current source target evaluation');
    const terminal = fixture.rows(edit).at(-1);
    assert.equal(terminal.kind, 'tool.succeeded');
    assert.equal(terminal.mapping, 'exact');
    const oldMethodId = [...byId.values()].find(value => value.label === 'saveOrder').id;
    assert.equal(terminal.entityIds.includes(oldMethodId), false);
    await show('orders.js', 'edit', 'succeeded', 'Edited');
    await entity('saveOrder').waitFor({ state: 'visible' });
    assert.equal(await entity('saveOrder').locator('.tool-activity-badge[data-operation="edit"]').count(), 0,
      'the latest exact terminal withdraws the old method highlight while current mapping is held');
    assert.equal(changedSourceGate.released, false);
  } finally { changedSourceGate.release(); }
  await fixture.pipeline.whenIdle();
  await mapped(edit, 'succeeded');
  await show('saveOrder', 'edit', 'succeeded', 'Edited');
  checks.push('Changed-source exact completion withdraws the old method target; only a new current mapping restores it');
  const failed = await fixture.hook(payload('PreToolUse', 'Edit', 'failed-edit'));
  await mapped(failed);
  await fixture.hook(payload('PostToolUseFailure', 'Edit', 'failed-edit'));
  await show('orders.js', 'edit', 'failed', 'Edit failed');
  assert.equal(fixture.rows(failed).at(-1).outcome, 'failed');
  await shot('04-edit-failed');
  checks.push('A real synthetic source edit completes, while a separate failed edit retains its failed outcome');

  phase = 'late mapping preserves terminal lifecycle';
  const lateGate = fixture.holdNextMapping();
  const late = await fixture.hook(payload('PreToolUse', 'Read', 'late-read'));
  await bounded(lateGate.started, 'late target evaluation');
  const releaseTimer = setTimeout(lateGate.release, 280);
  try {
    await fixture.hook(payload('PostToolUse', 'Read', 'late-read'));
    const terminal = fixture.rows(late).findLast(row => row.kind === 'tool.succeeded');
    assert.ok(terminal);
    assert.equal(lateGate.released, false, 'completion arrived while mapping was still held');
    await mapped(late, 'succeeded');
    const enriched = fixture.rows(late).at(-1);
    assert.equal(enriched.at, terminal.at, 'mapping arrival cannot reset completion time');
    assert.ok(Date.parse(enriched.recordedAt) >= Date.parse(terminal.recordedAt));
    assert.equal(enriched.outcome, 'succeeded');
    assert.equal(enriched.sessionId, terminal.sessionId);
    assert.equal(enriched.agentId, terminal.agentId);
    assert.equal(enriched.toolCallId, terminal.toolCallId);
    await show('orders.js', 'read', 'succeeded', 'Read');
    assert.equal(await badge('orders.js', 'read', 'pending').count(), 0);
  } finally { clearTimeout(releaseTimer); lateGate.release(); }
  checks.push('Mapping returned after completion keeps its exact session/agent/call, terminal outcome and lifecycle timestamp');

  phase = 'replay with recorded pending activity stays quiet';
  const replayCall = await fixture.hook(payload('PreToolUse', 'Read', 'session-read'));
  await mapped(replayCall);
  await page.locator('#visualizer').selectOption('graphlin.changes');
  await page.getByRole('button', { name: 'Set baseline now', exact: true }).click();
  const checkpoint = await until(() => fixture.model().checkpoints.at(-1), 'created checkpoint');
  const historical = fixture.pipeline.getModelState({ checkpointId: checkpoint.id });
  assert.ok(historical.activity.some(row => row.toolCallId === replayCall.toolCallId && row.outcome === 'pending'));
  await page.locator('#visualizer').selectOption('graphlin.blocks');
  await page.locator('#model-position').selectOption(checkpoint.id);
  await until(async () => await page.locator('.tool-activity-badge').count() === 0, 'quiet replay');
  assert.equal(await page.locator('#current-activity').isVisible(), false);
  await shot('05-replay-quiet');
  await page.locator('#model-position').selectOption('');
  await show('orders.js', 'read', 'pending', 'Reading');
  checks.push('A real checkpoint containing pending activity is quiet in replay and resumes only on Live');

  phase = 'new session and Follow off preserve user camera';
  await expand('receipts.js');
  await expand('ReceiptDesk');
  await page.getByRole('checkbox', { name: 'Follow agent', exact: true }).uncheck();
  const secondSession = await fixture.startSession('harbor-second');
  await page.waitForFunction(session => document.querySelector('#session').value === session, secondSession);
  await page.waitForFunction(session => window.__activityBrowserCheck.model?.session === session, secondSession);
  assert.equal(await page.locator('.tool-activity-badge').count(), 0);
  // Sessions own separate presentations. Measure activity-induced movement
  // after choosing the camera in this session, not across the session switch.
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const camera = await recordCamera('manual camera before activity');
  const second = await fixture.hook(payload('PreToolUse', 'Read', 'session-read', 'harbor-second', 'app/receipts.js'));
  await mapped(second);
  await show('sendReceipt', 'read', 'pending', 'Reading');
  await recordCamera('new session read visible');
  assert.equal(await badge('orders.js', 'read', 'pending').count(), 0);
  await fixture.hook(payload('PostToolUse', 'Read', 'session-read'));
  await show('sendReceipt', 'read', 'pending', 'Reading');
  const afterActivity = await recordCamera('old session completion ignored');
  if (afterActivity !== camera) failures.push({ phase, error: 'Activity changed the manual camera with Follow off',
    expected: camera, actual: afterActivity });
  assert.equal(await page.locator('#visualizer').inputValue(), 'graphlin.blocks');
  checks.push('New-session hooks replace old highlights and old-session completions cannot finish the current call');
  if (afterActivity === camera) checks.push('Follow off preserves the manually zoomed camera when activity appears');

  phase = 'terminal expiry with no SSE';
  await fixture.hook(payload('PostToolUse', 'Read', 'session-read', 'harbor-second', 'app/receipts.js'));
  await fixture.pipeline.whenIdle();
  await show('sendReceipt', 'read', 'succeeded', 'Read');
  const terminalDeliveries = await silenceStreams();
  await page.clock.fastForward(4500);
  assert.equal(await page.locator('.tool-activity-badge').count(), 0);
  assert.equal(await page.locator('#current-activity').isVisible(), false);
  await verifySilent(terminalDeliveries);
  assert.equal(fixture.rows(second).at(-1).outcome, 'succeeded');
  checks.push('Read completion disappears after four seconds with both actual SSE transports silent');

  phase = 'active expiry with no SSE';
  await page.reload();
  await page.waitForFunction(() => window.__activityBrowserCheck.model !== null);
  const idle = await fixture.hook(payload('PreToolUse', 'Edit', 'idle-edit', 'harbor-second', 'app/receipts.js'));
  await mapped(idle);
  await current('edit', 'pending').waitFor();
  const activeDeliveries = await silenceStreams();
  await page.clock.fastForward(60_100);
  assert.equal(await current('edit', 'pending').count(), 0);
  assert.equal(await page.locator('.tool-activity-badge[data-outcome="pending"]').count(), 0);
  await page.clock.fastForward(4500);
  assert.equal(await page.locator('.tool-activity-badge').count(), 0);
  assert.equal(await page.locator('#current-activity').isVisible(), false);
  await verifySilent(activeDeliveries);
  assert.equal(fixture.rows(idle).at(-1).outcome, 'pending', 'only the browser clock advanced');
  checks.push('An unanswered call leaves active state at sixty seconds and its unresolved notice also expires without SSE');

  assert.ok(fixture.mappings.some(call => call.operation === 'read' && call.returned));
  assert.ok(fixture.mappings.some(call => call.operation === 'edit' && call.returned));
  phase = 'final browser diagnostics';
  assert.deepEqual(errors, []);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(outbound, []);
  assert.deepEqual(failures, []);
  await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify({
    checks, viewerVersion, pendingVisibleMs, mappings: fixture.mappings, cameras,
    seededActivity: false, realParser: true, realDecisionService: true,
    hookTransport: 'server.pipeline.ingest', clockControlledExpiry: true,
    pageErrors: errors, failedResponses, outboundOrigins: outbound,
  }, null, 2));
  await Promise.all(['failure.png', 'failure.json'].map(name => rm(path.join(artifacts, name), { force: true })));
  console.log(`Activity browser checks passed (${checks.length}). Artifacts: ${artifacts}`);
} catch (error) {
  console.error(`${phase}: ${error.stack}`);
  await page?.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 5000,
    mask: [page.locator('#project-path')], maskColor: '#e9edf1' }).catch(() => {});
  await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({
    phase, error: error.stack, checks, mappings: fixture.mappings, cameras, failures,
    activity: fixture.model().activity, pageErrors: errors, failedResponses,
    body: await page?.locator('body').innerText().catch(() => null),
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  finally { await fixture.close(); }
}
