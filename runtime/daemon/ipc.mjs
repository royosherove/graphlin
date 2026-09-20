import net from 'node:net';
import { MAX_IPC_BYTES, runtimeError } from './paths.mjs';

export function requestIPC(socketPath, value, { timeoutMs = 500, maxResponseBytes = MAX_IPC_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const body = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(body) > MAX_IPC_BYTES) return reject(runtimeError('input_too_large'));
    const socket = net.createConnection(socketPath);
    let parts = [], size = 0, finished = false;
    const timer = setTimeout(() => finish(runtimeError('daemon_unavailable')), timeoutMs);
    function finish(error, result) {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    }
    socket.on('error', () => finish(runtimeError('daemon_unavailable')));
    socket.on('connect', () => socket.write(body));
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxResponseBytes) return finish(runtimeError('response_too_large'));
      parts.push(chunk);
      if (!chunk.includes(10)) return;
      try { finish(null, JSON.parse(Buffer.concat(parts).toString('utf8').split('\n')[0])); }
      catch { finish(runtimeError('invalid_response')); }
    });
    socket.on('end', () => { if (!finished) finish(runtimeError('daemon_unavailable')); });
  });
}
