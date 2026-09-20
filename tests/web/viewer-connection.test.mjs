import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeConnectionInfo, startConnectionDialog } from '../../runtime/web/app.js';
import { createConnectionInfo } from '../../runtime/daemon/connection-info.mjs';
import { createDocument } from './fake-dom.mjs';

// Deliberately fictional fixture text: production commands come only from the
// confirmed local service response, never from viewer templates.
function info(overrides = {}) {
  return {
    projectRoot: '/fixture/Project with spaces',
    mode: 'live',
    instructions: [{
      id: 'fixture-agent', title: 'Fixture agent', description: 'Test-only connection instructions.',
      steps: [
        { label: 'Fixture first step', command: "fixture-command '/fixture/Project with spaces'", description: 'A fixture command.' },
        { label: 'Fixture second step', command: 'fixture-command --second' },
      ],
    }],
    notes: ['Fixture note.'],
    ...overrides,
  };
}

async function setup(load, clipboard = { writeText: async () => {} }) {
  const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
  const document = createDocument(markup);
  const keys = ['document', 'window', 'fetch'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.document = document;
  globalThis.window = { navigator: { clipboard } };
  const controller = startConnectionDialog(load ? { load } : {});
  return {
    document, controller, $: id => document.getElementById(id), markup,
    close() {
      controller.dispose();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

function descendants(element, tag) {
  return element.children.flatMap(child => [
    ...(child.tagName === tag ? [child] : []), ...descendants(child, tag),
  ]);
}

test('connection payload admits only the provisional display contract and preserves complete command bytes', () => {
  const input = info({ key: 'hidden-secret', launchToken: 'hidden-token', pluginRoots: ['ignored'] });
  input.instructions[0].steps[0].command = "fixture 'a b' '<tag>' '$(literal)' `literal`\nfixture --second-line";
  const normalized = normalizeConnectionInfo(input);
  assert.equal(normalized.instructions[0].steps[0].command, input.instructions[0].steps[0].command);
  assert.doesNotMatch(JSON.stringify(normalized), /hidden-secret|hidden-token|pluginRoots/);
  assert.throws(() => normalizeConnectionInfo({ instructions: [] }), /invalid_connection_info/);
  for (const command of ['', 'x'.repeat(8193), 'fixture\0command', 'fixture\u202ecommand']) {
    const invalid = info();
    invalid.instructions[0].steps[0].command = command;
    assert.throws(() => normalizeConnectionInfo(invalid), /invalid_connection_info/, 'never present a silently altered command');
  }
});

test('dialog has named controls, loads on demand, traps both Tab directions, closes on Escape, and restores focus', async () => {
  let resolve, loads = 0;
  const h = await setup(() => { loads++; return new Promise(done => { resolve = done; }); });
  const $ = h.$;
  try {
    assert.equal(loads, 0);
    assert.match(h.markup, /id="how-to-connect"[^>]*aria-haspopup="dialog"/);
    assert.match(h.markup, /<dialog[^>]*aria-labelledby="connection-dialog-title"/);
    $('how-to-connect').focus();
    const opening = $('how-to-connect').fire('click');
    assert.equal($('connection-dialog').open, true);
    assert.equal(h.document.activeElement, $('connection-dialog-close'));
    assert.equal($('connection-loading').hidden, false);
    assert.equal($('connection-instructions').getAttribute('aria-busy'), 'true');
    let prevented = false;
    await $('connection-dialog').fire('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'loading state traps focus on Close');
    resolve(info());
    await opening;
    assert.equal(loads, 1);
    assert.equal($('connection-loading').hidden, true);
    assert.match($('connection-dialog-intro').textContent, /Keep this viewer running.*second terminal.*set up if needed/);
    assert.equal($('connection-instructions').getAttribute('aria-busy'), 'false');
    const commands = descendants($('connection-instructions'), 'pre');
    commands.at(-1).focus();
    await $('connection-dialog').fire('keydown', { key: 'Tab' });
    assert.equal(h.document.activeElement, $('connection-dialog-close'));
    await $('connection-dialog').fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(h.document.activeElement, commands.at(-1));
    await $('connection-dialog').fire('keydown', { key: 'Escape' });
    assert.equal($('connection-dialog').open, false);
    assert.equal(h.document.activeElement, $('how-to-connect'));
    assert.equal($('connection-instructions').childElementCount, 0, 'closed dialogs release command/path content');
    assert.match(h.markup, /Keep the server terminal open\. Open a new terminal/);
  } finally { h.close(); }
});

test('commands and descriptions remain literal text; Copy uses exact provided bytes and reports success/failure', async () => {
  const copied = [];
  let fail = false;
  const supplied = info({ projectRoot: '/fixture/<img src=x>', mode: 'demo', notes: ['<script>fixture</script>'] });
  supplied.instructions[0].description = '<img src=x onerror=fixture>';
  supplied.instructions[0].steps[0].command = "fixture '<img src=x>' '$(literal)' `literal`\nfixture --next";
  const h = await setup(async () => supplied, {
    async writeText(text) { if (fail) throw new Error('denied'); copied.push(text); },
  });
  const $ = h.$;
  try {
    await $('how-to-connect').fire('click');
    const body = $('connection-instructions');
    assert.ok(body.textContent.includes('<img src=x onerror=fixture>'));
    assert.equal(body.querySelector('img'), null);
    assert.equal($('connection-notes').querySelector('script'), null);
    assert.equal($('connection-demo').hidden, false);
    assert.match($('connection-demo').textContent, /offline demo.*own project/);
    assert.match($('connection-dialog-intro').textContent, /Start Graphlin in your project.*second terminal/);
    const buttons = descendants(body, 'button');
    await buttons[0].fire('click');
    assert.deepEqual(copied, [supplied.instructions[0].steps[0].command]);
    assert.equal(buttons[0].textContent, 'Copied');
    assert.equal($('connection-copy-status').textContent, 'Fixture first step copied.');
    fail = true;
    await buttons[1].fire('click');
    assert.match($('connection-copy-status').textContent, /Select the command text and copy it manually/);
    assert.equal(h.document.activeElement, descendants(body, 'pre')[1]);
  } finally { h.close(); }
});

for (const mode of ['live', 'demo']) {
  test(`${mode} dialog renders and copies the npm guide with the current data directory`, async () => {
    const supplied = await createConnectionInfo({
      projectRoot: '/fixture/Current project', dataDir: '/fixture/Custom data', mode,
    });
    const copied = [];
    const h = await setup(async () => supplied, { writeText: async text => copied.push(text) });
    try {
      await h.$('how-to-connect').fire('click');
      const body = h.$('connection-instructions');
      const expected = supplied.instructions.flatMap(item => item.steps.map(step => step.command));
      assert.deepEqual(descendants(body, 'code').map(item => item.textContent), expected);
      for (const button of descendants(body, 'button')) await button.fire('click');
      assert.deepEqual(copied, expected);
      assert.match(body.textContent, /npx --yes graphlin@latest/);
      assert.match(body.textContent, /\/plugin/);
      assert.match(body.textContent, /\/hooks/);
      assert.match(body.textContent, /masked prompt/);
      assert.doesNotMatch(body.textContent, /--plugin-dir|build-packages|marketplace add|resume --last/);
      assert.equal(expected[0].endsWith(' init'), mode === 'live');
      assert.equal(h.$('connection-demo').hidden, mode === 'live');
      assert.match(h.$('connection-notes').textContent, /Installation does not confirm hook activation/);
      if (mode === 'live') assert.match(h.$('connection-notes').textContent, /stopping and restarting/);
      else assert.doesNotMatch(body.textContent, /Current project/);
    } finally { h.close(); }
  });
}

test('load errors expose Retry; native cancellation restores focus; old responses cannot populate a reopened dialog', async () => {
  let reject = true, resolveOld;
  const h = await setup(async () => {
    if (reject) throw new Error('not ready');
    return info();
  });
  const $ = h.$;
  try {
    $('how-to-connect').focus();
    await $('how-to-connect').fire('click');
    assert.equal($('connection-error').hidden, false);
    assert.equal($('connection-instructions-retry').hidden, false);
    reject = false;
    $('connection-instructions-retry').focus();
    await $('connection-instructions-retry').fire('click');
    assert.equal($('connection-error').hidden, true);
    assert.equal($('connection-instructions-retry').hidden, true);
    assert.equal(h.document.activeElement, $('connection-dialog-close'));
    await $('connection-dialog').fire('cancel');
    assert.equal($('connection-dialog').open, false);
    assert.equal(h.document.activeElement, $('how-to-connect'));
  } finally { h.close(); }

  let requestCount = 0;
  const next = await setup(() => ++requestCount === 1
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve(info({ projectRoot: '/fixture/new' })));
  try {
    const first = next.$('how-to-connect').fire('click');
    await next.$('connection-dialog-close').fire('click');
    await next.$('how-to-connect').fire('click');
    await next.$('connection-dialog').fire('close');
    assert.equal(next.$('connection-dialog').open, true, 'an old native close event cannot close a reopened panel');
    resolveOld(info({ projectRoot: '/fixture/old' }));
    await first;
    assert.equal(next.$('connection-project').textContent, 'Project: /fixture/new');
  } finally { next.close(); }
});

test('default loader uses only the local authenticated connection-info endpoint and has an empty state', async () => {
  const h = await setup();
  try {
    const requests = [];
    globalThis.fetch = async (path, options) => {
      requests.push({ path, options });
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(info({ instructions: [] })) };
    };
    await h.$('how-to-connect').fire('click');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/connection-info');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.equal(requests[0].options.body, undefined);
    assert.match(h.$('connection-instructions').textContent, /No connection instructions are available/);
  } finally { h.close(); }
});
