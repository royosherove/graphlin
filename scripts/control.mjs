#!/usr/bin/env node
import { startDaemon, stopDaemon, daemonStatus, doctor, publicError } from '../runtime/daemon/manager.mjs';

const METHODS = { start: input => startDaemon({ ...input, background: true }),
  stop: stopDaemon, status: daemonStatus, doctor };
const SCHEMA = { type: 'object', properties: { projectRoot: { type: 'string', minLength: 1, maxLength: 4096 } },
  required: ['projectRoot'], additionalProperties: false };
const TOOLS = Object.keys(METHODS).map(name => ({
  name,
  description: {
    start: 'Start or reopen Graphlin for an explicit project and return a one-use viewer URL. Reuses saved project consent and credentials; metadata only without consent. Omit policy fields to reuse the current policy. MCP launch runs in the background; use the CLI for foreground operation.',
    stop: 'Stop the Graphlin daemon for this canonical project.',
    status: 'Get safe daemon status; does not activate hooks or call a remote service.',
    doctor: 'Check local configuration, credential presence, host versions, daemon health, and observed hook delivery. Returns next steps; never sends a remote request or exposes a key.',
  }[name],
  inputSchema: name === 'start' ? { ...SCHEMA, properties: { ...SCHEMA.properties,
    allowSource: { type: 'boolean' }, persistEvidence: { type: 'boolean' },
    displayEvidence: { type: 'boolean' } } } : SCHEMA,
  annotations: { readOnlyHint: name === 'status' || name === 'doctor',
    destructiveHint: false, openWorldHint: name === 'start' },
}));
let initialized = false;
const send = message => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolve());
});
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
async function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { await error(null, -32700, 'Parse error'); return; }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')) {
    await error(null, -32600, 'Invalid request'); return;
  }
  if (message.id === undefined) return; // All notifications are deliberately silent.
  const result = value => send({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize') {
    if (initialized) return error(message.id, -32600, 'Already initialized');
    initialized = true;
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
    return result({ protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'graphlin', version: '0.2.1' },
      instructions: 'Controls only. Passive host hooks provide observations when separately activated. No drawing calls after each action.' });
  }
  if (message.method === 'ping') return result({});
  if (!initialized) return error(message.id, -32002, 'Initialize first');
  if (message.method === 'tools/list') return result({ tools: TOOLS });
  if (message.method !== 'tools/call') return error(message.id, -32601, 'Method not found');
  const name = message.params?.name, input = message.params?.arguments;
  if (!Object.hasOwn(METHODS, name ?? '') || !input || Array.isArray(input) || typeof input !== 'object') {
    return error(message.id, -32602, 'Invalid tool arguments');
  }
  const allowed = new Set(name === 'start' ? ['projectRoot', 'allowSource', 'persistEvidence', 'displayEvidence'] : ['projectRoot']);
  if (typeof input.projectRoot !== 'string' || !input.projectRoot || input.projectRoot.length > 4096 ||
      Object.keys(input).some(key => !allowed.has(key)) ||
      Object.entries(input).some(([key, value]) => key !== 'projectRoot' && typeof value !== 'boolean')) {
    return error(message.id, -32602, 'Invalid tool arguments');
  }
  try {
    const value = await METHODS[name](input);
    await result({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
  } catch (failure) {
    await result({ content: [{ type: 'text', text: JSON.stringify({ error: publicError(failure) }) }], isError: true });
  }
}
let buffer = '', discarding = false;
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (discarding) { discarding = false; continue; }
    if (Buffer.byteLength(line) > 64 * 1024) await error(null, -32600, 'Request too large');
    else if (line.trim()) await handle(line).catch(() => error(null, -32603, 'Internal error'));
  }
  if (Buffer.byteLength(buffer) > 64 * 1024) {
    buffer = ''; discarding = true; await error(null, -32600, 'Request too large');
  }
}
