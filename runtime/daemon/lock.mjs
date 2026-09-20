import { mkdir, rename, rm, lstat, opendir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicJSON, privateDirectory, readPrivateJSON, runtimeError, uid, PROTOCOL } from './paths.mjs';
import { requestIPC } from './ipc.mjs';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const CLAIM_NAME = /^([1-9]\d*)-([0-9a-f-]{36})$/;
const busy = () => runtimeError('daemon_busy');
const absent = error => { if (error.code !== 'ENOENT') throw error; return null; };

// Bakery tickets serialize publication and removal, not the daemon lifetime.
// A unique directory registers "choosing" before any ticket is read or written.
// Its PID is in its name, so even a crash before writing the ticket is recoverable.
// Unlike a fixed reaping guard, deleting a dead claim can never delete a successor.
async function claims(directory) {
  const result = [];
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    if (++scanned > 1024) throw busy();
    const match = CLAIM_NAME.exec(entry.name);
    if (!match || !entry.isDirectory()) throw busy();
    const filename = path.join(directory, entry.name), pid = Number(match[1]);
    if (!alive(pid)) {
      await rm(filename, { recursive: true, force: true });
      continue;
    }
    const ticketPath = path.join(filename, 'ticket.json');
    const ticket = await readPrivateJSON(ticketPath, 4096).catch(async error => {
      // A departing peer can unlink an already-open ticket before fstat;
      // readPrivateJSON then correctly rejects its zero link count. Treat
      // only a now-absent ticket as a choosing/departing peer, never as ready.
      if (error.code === 'ENOENT' || !await lstat(ticketPath).catch(absent)) return null;
      throw busy();
    });
    if (ticket && (ticket.id !== entry.name || !Number.isSafeInteger(ticket.number) || ticket.number < 1)) throw busy();
    // A peer may have finished between directory enumeration and reading.
    if (!ticket && !await lstat(filename).catch(absent)) continue;
    result.push({ id: entry.name, number: ticket?.number ?? null });
    if (result.length > 64) throw busy();
  }
  return result;
}

async function withPublicationGuard(paths, action) {
  const directory = `${paths.lock}.claims`;
  await privateDirectory(directory);
  const id = `${process.pid}-${randomUUID()}`, claim = path.join(directory, id);
  await mkdir(claim, { mode: 0o700 });
  try {
    const peers = await claims(directory);
    const number = 1 + Math.max(0, ...peers.map(peer => peer.number ?? 0));
    if (!Number.isSafeInteger(number)) throw busy();
    await atomicJSON(path.join(claim, 'ticket.json'), { id, number }, 4096);
    const deadline = Date.now() + 2000;
    while (true) {
      const pending = (await claims(directory)).some(peer => peer.id !== id &&
        (peer.number === null || peer.number < number || (peer.number === number && peer.id < id)));
      if (!pending) return await action(claim);
      if (Date.now() >= deadline) throw busy();
      await wait(20);
    }
  } finally {
    await rm(claim, { recursive: true, force: true });
  }
}

async function existingOwner(paths) {
  const info = await lstat(paths.lock).catch(absent);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
      (uid() !== undefined && info.uid !== uid())) throw busy();
  const owner = await readPrivateJSON(path.join(paths.lock, 'owner.json'), 4096).catch(error => {
    if (error.code !== 'ENOENT') throw busy();
    return null;
  });
  if (owner) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.instanceId !== 'string') throw busy();
    return owner;
  }
  // Legacy versions could expose an empty directory before owner.json was
  // committed. Respect any complete live owner in an interrupted temp write.
  let scanned = 0;
  for await (const entry of await opendir(paths.lock)) {
    if (++scanned > 64 || !/^owner\.json\.[0-9a-f-]+\.tmp$/.test(entry.name) || !entry.isFile()) throw busy();
    const partial = await readPrivateJSON(path.join(paths.lock, entry.name), 4096).catch(() => null);
    if (partial && alive(partial.pid)) throw busy();
  }
  return null;
}

export async function health(paths) {
  const owner = await readPrivateJSON(path.join(paths.lock, 'owner.json'), 4096);
  if (owner.protocol !== PROTOCOL || owner.projectId !== paths.projectId) throw runtimeError('invalid_owner');
  const result = await requestIPC(paths.socket, { op: 'health', instanceId: owner.instanceId });
  if (!result.ok || result.instanceId !== owner.instanceId || result.projectId !== paths.projectId ||
      result.protocol !== PROTOCOL || result.pid !== owner.pid) throw runtimeError('invalid_daemon');
  return result;
}

export async function acquireLock(paths) {
  const owner = { protocol: PROTOCOL, projectId: paths.projectId, pid: process.pid,
    instanceId: randomUUID(), createdAt: Date.now() };
  await withPublicationGuard(paths, async claim => {
    const previous = await existingOwner(paths);
    // Never kill or displace a live PID, including one without working IPC.
    if (previous && alive(previous.pid)) {
      try { await health(paths); } catch { throw busy(); }
      throw runtimeError('already_running');
    }
    await rm(paths.lock, { recursive: true, force: true });
    await rm(`${paths.lock}.reaping`, { recursive: true, force: true });
    const publication = path.join(claim, 'publication');
    await mkdir(publication, { mode: 0o700 });
    await atomicJSON(path.join(publication, 'owner.json'), owner, 4096);
    // The public lock first becomes visible with its complete owner record.
    // A crash before this rename leaves only a uniquely named dead claim.
    await rename(publication, paths.lock);
  });
  let releasing;
  return {
    owner,
    release() {
      releasing ??= withPublicationGuard(paths, async () => {
        const current = await existingOwner(paths);
        if (current?.instanceId === owner.instanceId) await rm(paths.lock, { recursive: true, force: true });
      });
      return releasing;
    },
  };
}
