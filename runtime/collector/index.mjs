import { projectPaths, MAX_IPC_BYTES } from '../daemon/paths.mjs';
import { requestIPC } from '../daemon/ipc.mjs';

export async function collect(payload, { host = 'claude', dataDir, timeoutMs = 200 } = {}) {
  if (!['claude', 'codex', 'kiro'].includes(host) || !payload || Array.isArray(payload) ||
      typeof payload !== 'object' || typeof payload.cwd !== 'string') return false;
  try {
    const paths = await projectPaths(payload.cwd, dataDir);
    const reply = await requestIPC(paths.socket, { host, payload }, { timeoutMs });
    return reply.ok === true;
  } catch { return false; }
}

export async function readHook(stream = process.stdin) {
  const parts = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_IPC_BYTES - 256) return null;
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { return null; }
}
