// Optional actual-daemon browser check. Run explicitly with Playwright available;
// it never attaches to an existing browser or uses an existing project/profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startDaemonBrowserFixture } from './platform-daemon-fixture.mjs';

const require = createRequire(process.env.GRAPHLIN_BROWSER_DEPENDENCIES
  ? path.join(process.env.GRAPHLIN_BROWSER_DEPENDENCIES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const artifacts = path.resolve(process.env.GRAPHLIN_BROWSER_ARTIFACTS || '/tmp/graphlin-browser-check');
await mkdir(artifacts, { recursive: true });
const fixture = await startDaemonBrowserFixture();
let browser;
const failures = [], requests = [], frameResponses = [], failedResponses = [];
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.GRAPHLIN_BROWSER_EXECUTABLE ? { executablePath: process.env.GRAPHLIN_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('request', request => requests.push({ path: new URL(request.url()).pathname,
    method: request.method(), body: request.postData() }));
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
    if (new URL(response.url()).pathname.startsWith('/api/extensions/frame/')) frameResponses.push(response);
  });
  const selectView = value => page.getByRole('combobox', { name: 'Visualizer', exact: true }).selectOption(value);
  const status = page.locator('#view-status');
  const shot = name => page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: false });
  await page.goto(fixture.url);
  await page.locator('#visualizer option[value="example.timeline-fixture"]').waitFor({ state: 'attached' });

  await selectView('graphlin.blocks');
  await page.getByRole('button', { name: 'Expand app', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Expand gateway.js', exact: true }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await shot('blocks');
  await page.getByRole('searchbox', { name: 'Find components' }).fill('saveSession');
  await page.getByRole('button', { name: /^saveSession\./ }).waitFor();
  await page.getByRole('searchbox', { name: 'Find components' }).press('Escape');

  await selectView('graphlin.c4');
  await page.getByRole('button', { name: /^Notes application\./ }).waitFor();
  await shot('c4-applications');
  await page.getByRole('combobox', { name: 'Level', exact: true }).selectOption('context');
  await page.getByText('Source scopes; application and responsibility boundaries unknown', { exact: false }).waitFor();
  await page.getByRole('combobox', { name: 'Level', exact: true }).selectOption('components');
  await page.getByText('Source scopes; application and responsibility boundaries unknown', { exact: false }).waitFor();

  await selectView('graphlin.changes');
  await page.getByRole('button', { name: 'Set baseline now', exact: true }).click();
  await page.locator('#task-baseline option', { hasText: 'Task baseline' }).waitFor({ state: 'attached' });
  await fixture.change();
  await page.getByText(/Since revision .*1 created/).waitFor();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await shot('changes');
  await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption({ label: 'Task baseline' });
  assert.equal(await page.getByRole('button', { name: 'Set baseline now', exact: true }).isEnabled(), false);

  await selectView('graphlin.timeline');
  await page.getByRole('searchbox', { name: 'Find components' }).fill('tool');
  const pending = page.getByRole('button', { name: 'test · tool requested. unresolved. No linked entity.', exact: true });
  await pending.waitFor();
  await page.setViewportSize({ width: 760, height: 650 });
  await shot('timeline-small');
  await pending.press('Enter');
  await page.getByRole('heading', { name: 'tool.requested', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find components' }).press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });

  await selectView('example.timeline-fixture');
  await page.getByRole('button', { name: 'Allow selected data', exact: true }).waitFor();
  assert.equal(requests.some(item => item.path.startsWith('/api/extensions/data/')), false);
  assert.equal(requests.some(item => item.path.startsWith('/api/extensions/frame/')), false);
  assert.equal(requests.some(item => item.path === '/api/extensions/analysis'), false);
  await page.getByRole('checkbox', { name: 'Allow retained history', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Allow grouping analysis (entities)', exact: true }).check();
  await shot('analysis-approval');
  await page.getByRole('button', { name: 'Allow selected data', exact: true }).click();
  const frame = page.frameLocator('#custom-view iframe');
  await frame.getByRole('heading', { name: 'Installed activity renderer', exact: true }).waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#custom-view iframe').getAttribute('sandbox'), 'allow-scripts');
  assert.ok(frameResponses.length);
  assert.equal(frameResponses[0].status(), 200);
  const headers = await frameResponses[0].allHeaders();
  assert.match(headers['content-security-policy'], /sandbox allow-scripts/);
  assert.match(headers['content-security-policy'], /connect-src 'none'/);
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(await status.isVisible(), false);
  await shot('installed-custom');
  await frame.getByRole('button', { name: 'test: pending', exact: true }).press('Enter');
  await page.getByRole('heading', { name: 'tool.requested', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Run analysis', exact: true }).isEnabled(), false);
  assert.equal(requests.some(item => item.path === '/api/extensions/analysis'), false);

  await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption({ label: 'Live' });
  await frame.getByRole('heading', { name: 'Installed activity renderer', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption({ label: 'Ocean' });
  assert.equal(requests.some(item => item.path === '/api/extensions/analysis'), false);
  const analysisResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/extensions/analysis');
  await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
  const analysis = await analysisResponse;
  const analysisRequest = requests.find(item => item.path === '/api/extensions/analysis');
  const input = JSON.parse(analysisRequest.body);
  assert.equal(input.profileId, 'grouping');
  assert.ok(input.entityIds.length > 0 && input.entityIds.length <= 256);
  assert.ok(Number.isSafeInteger(input.revision));
  assert.equal(analysis.status(), 200);
  assert.equal((await analysis.json()).status, 'unavailable', 'fixture has source transmission disabled');
  await shot('analysis-explicit-run');

  await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption({ label: 'Task baseline' });
  await frame.getByRole('heading', { name: 'Installed activity renderer', exact: true }).waitFor();
  await fixture.revoke();
  await page.locator('#custom-view iframe').waitFor({ state: 'detached', timeout: 4000 });
  await page.getByText('Visualizer access or its installed version changed. Review access before continuing.', { exact: true }).waitFor();
  await shot('replay-revoked');
  assert.deepEqual(failures, []);
  await writeFile(path.join(artifacts, 'verification.json'), JSON.stringify({
    checks: ['nested groups and keyboard expansion', 'search', 'C4 supported and unknown levels',
      'baseline/change/replay', 'small viewport timeline and keyboard inspection',
      'grant before data', 'real sandbox frame and custom status', 'frame selection',
      'explicit profile approval/run', 'source transmission remains disabled', 'revocation during replay'],
    pageErrors: failures, frameHTTPStatus: frameResponses[0].status(), analysisHTTPStatus: analysis.status(),
    analysisRequests: requests.filter(item => item.path === '/api/extensions/analysis').length,
  }, null, 2));
  console.log(`Browser checks passed. Artifacts: ${artifacts}`);
} catch (error) {
  console.error(error);
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
      await writeFile(path.join(artifacts, 'failure.txt'), `${error.stack}\n${failures.join('\n')}\n${JSON.stringify(failedResponses)}\n${await page.locator('body').innerText()}`);
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture.close();
}
