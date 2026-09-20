import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function workspace(t) {
  const base = await mkdtemp(path.join(await realpath(tmpdir()), 'graphlin runtime '));
  const projectRoot = path.join(base, 'project with spaces'), dataDir = path.join(base, 'private data');
  await mkdir(projectRoot);
  t.after(async () => {
    const { stopDaemon } = await import('../../runtime/daemon/manager.mjs');
    await stopDaemon({ projectRoot, dataDir }).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return { base, projectRoot, dataDir };
}
export function run(command, args, { input = '', env = process.env, cwd = process.cwd(), timeout = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child_timeout')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
export async function authenticate(server) {
  const launch = new URL(server.url), origin = launch.origin;
  const token = new URLSearchParams(launch.hash.slice(1)).get('token');
  const response = await fetch(`${origin}/api/auth`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (response.status !== 200) throw new Error('auth_failed');
  return { origin, token, cookie: response.headers.get('set-cookie').split(';')[0] };
}
