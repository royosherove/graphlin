import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspace, run } from './helpers.mjs';

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function subprocessFixture(t, base, { flood = false } = {}) {
  const prefix = path.join(base, 'probe'), names = [];
  async function cleanup() {
    for (const name of names) {
      const pid = Number(await readFile(`${prefix}-${name}.pid`, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
  t.after(cleanup);
  return {
    prefix, cleanup,
    async executable(filename, name) {
      names.push(name);
      // Shell builtins keep the recorded PID equal to the probed process;
      // there is no grandchild or second executable startup to race the timer.
      await writeFile(filename, `#!/bin/sh
probe_prefix=${shellQuote(`${prefix}-${name}`)}
trap 'printf received > "$probe_prefix.term"' TERM
printf '%s' "$$" > "$probe_prefix.pid"
${flood ? `printf '%s' '${'x'.repeat(5000)}'` : ''}
while :; do :; done
`, { mode: 0o755 });
    },
    async assertKilled(name) {
      const pid = Number(await readFile(`${prefix}-${name}.pid`, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.equal(await readFile(`${prefix}-${name}.term`, 'utf8'), 'received', 'TERM was attempted before KILL');
      const deadline = Date.now() + 1000;
      while (true) {
        try { process.kill(pid, 0); }
        catch (error) { assert.equal(error.code, 'ESRCH'); return; }
        assert.ok(Date.now() < deadline, 'TERM-ignoring subprocess must be killed');
        await delay(10);
      }
    },
  };
}

test('passive collector escalates to KILL when the executable ignores TERM, with silent bounded completion', async t => {
  const { base } = await workspace(t), fixture = await subprocessFixture(t, base);
  const executable = path.join(base, 'runtime with spaces');
  await fixture.executable(executable, 'collector');
  const started = Date.now();
  try {
    const result = await run('/bin/sh', [path.resolve('scripts/collect.sh')], {
      env: { ...process.env, GRAPHLIN_NODE: executable }, timeout: 4000,
    });
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    assert.ok(Date.now() - started < 2500, 'launcher stays below the host timeout budget');
    await fixture.assertKilled('collector');
  } finally { await fixture.cleanup(); }
});

for (const flood of [false, true]) {
  test(`doctor bounds TERM-ignoring version probes ${flood ? 'after excessive output' : 'after a timeout'}`, async t => {
    const { base, projectRoot, dataDir } = await workspace(t), fixture = await subprocessFixture(t, base, { flood });
    const bin = path.join(base, 'fake host commands');
    await mkdir(bin);
    for (const host of ['claude', 'codex']) await fixture.executable(path.join(bin, host), host);
    const harness = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const spawn = cp.spawn;
      cp.spawn = (command, args, options) => {
        if (!['claude', 'codex', 'kiro'].includes(command)) throw new Error('unexpected_command');
        return spawn(${JSON.stringify(bin)} + '/' + command, args, options);
      };
      syncBuiltinESMExports();
      const { doctor } = await import(${JSON.stringify(pathToFileURL(path.resolve('runtime/daemon/manager.mjs')).href)});
      console.log(JSON.stringify(await doctor(${JSON.stringify({ projectRoot, dataDir })})));
    `;
    const started = Date.now();
    try {
      const result = await run(process.execPath, ['--input-type=module', '-e', harness], {
        env: { ...process.env, PATH: bin }, timeout: 4000,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.ok(Date.now() - started < 2500, 'doctor must not wait forever for close after TERM');
      const report = JSON.parse(result.stdout);
      assert.equal(report.daemon.running, false);
      assert.equal(report.credential, 'not_checked_no_request_sent');
      // The third host is absent from this isolated PATH; unavailable probes
      // must also settle without invoking any actual installed host command.
      assert.equal(report.hosts.kiro.version, null);
      for (const host of ['claude', 'codex']) {
        assert.equal(report.hosts[host].version, null);
        await fixture.assertKilled(host);
      }
    } finally { await fixture.cleanup(); }
  });
}
