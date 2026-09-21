// Explicit browser check: real daemon IPC, local source parsing and both SSE
// transports. Uses a fresh synthetic project/browser; no provider is called.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createArchitectureFixture } from '../helpers/architecture-fixture.mjs';
import { projectPaths } from '../../runtime/daemon/paths.mjs';
import { requestIPC } from '../../runtime/daemon/ipc.mjs';

const require = createRequire(process.env.GRAPHLIN_BROWSER_DEPENDENCIES
  ? path.join(process.env.GRAPHLIN_BROWSER_DEPENDENCIES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const artifacts = path.resolve(process.env.GRAPHLIN_BROWSER_ARTIFACTS || '/tmp/graphlin-session-follow-browser-check');
await mkdir(artifacts, { recursive: true });
const f = await createArchitectureFixture({
  policy: { readSource: true, transmitSource: false, displayEvidence: true },
});
const paths = await projectPaths(f.projectRoot, f.dataDir);
const errors = [], failures = [], checks = [], queries = [];
let browser, page;
try {
  const initial = f.pipeline.getModelState();
  assert.deepEqual(initial.sessions, []);
  assert.ok(initial.entities.some(value => value.basis === 'parsed'));
  assert.match(initial.projectId, /^[a-f0-9]{64}$/);
  browser = await chromium.launch({ headless: true,
    ...(process.env.GRAPHLIN_BROWSER_EXECUTABLE ? { executablePath: process.env.GRAPHLIN_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [name, value] = f.cookie.split('=');
  await context.addCookies([{ name, value, url: f.origin, httpOnly: true, sameSite: 'Strict' }]);
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (['/api/model/v1/snapshot', '/api/model/v1/events'].includes(url.pathname))
      queries.push({ path: url.pathname, session: url.searchParams.get('session') });
  });
  // Observe real EventSource deliveries without substituting responses or
  // reaching into the viewer's private application state.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const received = window.__sessionFollowCheck = { legacy: null, model: null };
    let activeModel;
    window.EventSource = class extends Native {
      constructor(url, options) {
        super(url, options);
        const route = new URL(url, location.href);
        if (route.pathname === '/api/model/v1/events') activeModel = this;
        this.addEventListener('snapshot', event => {
          const data = JSON.parse(event.data);
          if (route.pathname === '/api/events') received.legacy = {
            session: data.sessionId, receipt: data.hookEvents.at(-1)?.receipt ?? 0,
          };
          if (route.pathname === '/api/model/v1/events' && activeModel === this) received.model = {
            querySession: route.searchParams.get('session'),
            session: data.selection?.sessionId ?? null,
            activitySessions: data.activity.map(value => value.sessionId),
          };
        });
      }
    };
  });
  await page.goto(f.origin);
  await page.waitForFunction(() => window.__sessionFollowCheck.model !== null);
  await page.locator('#visualizer').selectOption('graphlin.c4');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  let view = 'graphlin.c4';
  const start = (session_id, source) => ({ hook_event_name: 'SessionStart', session_id, source });
  async function hook(payload) {
    assert.equal((await requestIPC(paths.socket, {
      host: 'claude', payload: { cwd: f.projectRoot, ...payload },
    }, { timeoutMs: 3000 })).ok, true);
    await f.pipeline.whenIdle();
    return f.pipeline.getState();
  }
  async function activity(session_id, tool_name) {
    await hook({ hook_event_name: 'PreToolUse', session_id, tool_name,
      tool_use_id: `synthetic-${session_id}-${tool_name}`,
      tool_input: { file_path: path.join(f.projectRoot, 'orders.js') } });
  }
  async function verify(step, session) {
    const state = f.pipeline.getState();
    assert.equal(state.sessionId, session, `${step}: backend authoritative selection`);
    const receipt = state.hookEvents.at(-1).receipt;
    await page.waitForFunction(({ session, receipt }) => {
      const latest = window.__sessionFollowCheck.legacy;
      return latest?.session === session && latest.receipt >= receipt;
    }, { session, receipt });
    const titles = [...state.activity].sort((a, b) => b.sequence - a.sequence || (b.at || 0) - (a.at || 0))
      .map(value => value.label);
    try {
      await page.waitForFunction(({ session, view, titles }) => {
        const latest = window.__sessionFollowCheck.model;
        return document.querySelector('#session').value === session &&
          document.querySelector('#visualizer').value === view &&
          latest?.querySession === session && latest.session === session &&
          latest.activitySessions.length > 0 && latest.activitySessions.every(value => value === session) &&
          JSON.stringify([...document.querySelectorAll('#activity-list .event-title')].map(value => value.textContent)) === JSON.stringify(titles);
      }, { session, view, titles }, { timeout: 3000 });
      checks.push({ step, backend: true, browser: true, view });
    } catch {
      const observed = await page.evaluate(() => ({
        ...window.__sessionFollowCheck,
        selector: document.querySelector('#session').value,
        view: document.querySelector('#visualizer').value,
        activity: [...document.querySelectorAll('#activity-list .event-title')].map(value => value.textContent),
      }));
      failures.push({ step, expectedSession: session, expectedView: view, observed });
      checks.push({ step, backend: true, browser: false, view });
    }
  }

  const firstStart = start('synthetic-first', 'startup');
  const first = (await hook(firstStart)).sessionId;
  await activity('synthetic-first', 'Read');
  await verify('startup after source-only scan', first);
  // Explicitly choosing the old session exercises the formerly pinned v2 query.
  await page.locator('#session').selectOption(first);
  await page.waitForFunction(session => window.__sessionFollowCheck.model?.querySession === session, first);
  const second = (await hook(start('synthetic-second', 'clear'))).sessionId;
  assert.notEqual(second, first);
  await activity('synthetic-second', 'Write');
  await verify('new session replaces old model selection', second);
  await hook(firstStart);
  await verify('duplicate startup cannot steal selection', second);
  await hook(start('synthetic-first', 'compact'));
  await verify('background compaction cannot steal selection', second);

  view = 'graphlin.blocks';
  await page.locator('#visualizer').selectOption(view);
  const resume = start('synthetic-first', 'resume');
  await hook(resume);
  await verify('resume follows the existing session without changing Blocks', first);
  const third = (await hook(start('synthetic-third', 'clear'))).sessionId;
  assert.notEqual(third, first);
  assert.notEqual(third, second);
  await activity('synthetic-third', 'Read');
  await activity('synthetic-third', 'Write');
  await verify('new session follows while Blocks remains selected', third);
  await hook(resume);
  await verify('duplicate resume cannot steal selection', third);
  await hook(start('synthetic-second', 'compact'));
  await verify('late old compaction keeps current session and activity', third);

  assert.equal(f.provider.calls.length, 0);
  await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify({
    sourceOnlyInitialScan: true, providerCalls: f.provider.calls.length,
    checks, queries, failures, pageErrors: errors,
  }, null, 2));
  console.log(`Session follow: ${checks.length} backend/legacy-stream checks passed; ${checks.filter(value => value.browser).length} browser/model-stream checks passed.`);
  assert.deepEqual(errors, []);
  assert.deepEqual(failures.map(value => value.step), [],
    `Session follow failed; detailed observations are in ${path.join(artifacts, 'verification.json')}`);
} finally {
  await browser?.close();
  await f.close();
}
