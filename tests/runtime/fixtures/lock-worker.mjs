// Isolated test process: filesystem locking only, no server or service calls.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { projectPaths } from '../../../runtime/daemon/paths.mjs';

const [projectRoot, dataDir, phase] = process.argv.slice(2);
const paths = await projectPaths(projectRoot, dataDir, { create: true });
async function checkpoint() {
  process.send({ checkpoint: phase, pid: process.pid });
  await new Promise(() => {});
}
if (phase === 'choosing') {
  const mkdir = fs.mkdir;
  fs.mkdir = async (filename, ...args) => {
    const result = await mkdir(filename, ...args);
    if (path.dirname(filename) === `${paths.lock}.claims`) await checkpoint();
    return result;
  };
}
if (phase === 'publication') {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === paths.lock) await checkpoint();
    return rename(from, to);
  };
}
syncBuiltinESMExports();
const { acquireLock } = await import('../../../runtime/daemon/lock.mjs');
let lock;
process.on('message', async message => {
  if (message === 'acquire') {
    try { lock = await acquireLock(paths); process.send({ acquired: true, owner: lock.owner }); }
    catch (error) { process.send({ acquired: false, code: error.code }); }
  } else if (message === 'release') {
    await lock?.release();
    process.exit(0);
  }
});
process.send({ ready: true });
