import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rename, rm, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export const PROTOCOL = 1;
export const MAX_IPC_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const uid = () => process.getuid?.();
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const runtimeError = (code) => Object.assign(new Error(code), { code });

export function defaultDataDir() {
  return path.resolve(process.env.GRAPHLIN_DATA_DIR || path.join(homedir(), '.local', 'state', 'graphlin'));
}

export async function canonicalProjectRoot(input) {
  if (typeof input !== 'string' || !input || input.length > 4096) throw runtimeError('invalid_project');
  const resolved = await realpath(path.resolve(input));
  if (!(await lstat(resolved)).isDirectory()) throw runtimeError('invalid_project');
  // A .git file identifies a worktree just as a .git directory identifies a checkout.
  // No transcript discovery, repository command, or recursive source scan is needed.
  let current = resolved;
  while (true) {
    try {
      const stat = await lstat(path.join(current, '.git'));
      if (stat.isFile() || stat.isDirectory()) return current;
    } catch (error) { if (error.code !== 'ENOENT') throw runtimeError('project_unavailable'); }
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid() !== undefined && stat.uid !== uid())) {
    throw runtimeError('unsafe_data_directory');
  }
  await chmod(directory, 0o700);
  return realpath(directory);
}

export async function projectPaths(projectRoot, dataDir = defaultDataDir(), { create = false } = {}) {
  if (process.platform === 'win32') throw runtimeError('unsupported_platform');
  const root = await canonicalProjectRoot(projectRoot);
  const requested = path.resolve(dataDir);
  // Resolve existing parent aliases, e.g. macOS /var -> /private/var, even before
  // the leaf exists so collector/start agree on the same socket name.
  async function resolveFuture(value) {
    try { return await realpath(value); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(value);
      if (parent === value) throw error;
      return path.join(await resolveFuture(parent), path.basename(value));
    }
  }
  if (create) await privateDirectory(requested);
  const base = await resolveFuture(requested);
  const projectId = hash(root);
  const directory = path.join(base, projectId);
  // Unix socket paths are short even if the project/data path contains spaces
  // or exceeds sockaddr_un's platform limit.
  const sockets = path.join('/tmp', `graphlin-${uid() ?? 'user'}`);
  const socket = path.join(sockets, `${hash(`${base}\0${root}`).slice(0, 36)}.sock`);
  if (create) {
    await privateDirectory(directory);
    await privateDirectory(sockets);
  }
  return { projectRoot: root, projectId, dataDir: base, directory, socket,
    lock: path.join(directory, 'daemon.lock'), state: path.join(directory, 'state.json') };
}

export async function readPrivateJSON(filename, limit = MAX_STATE_BYTES) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit || stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 || (uid() !== undefined && stat.uid !== uid())) {
      throw runtimeError('unsafe_state_file');
    }
    const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw runtimeError('state_too_large');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file?.close(); }
}

export async function atomicJSON(filename, value, limit = MAX_STATE_BYTES) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > limit) throw runtimeError('state_too_large');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(body);
    await file.sync();
    await file.close(); file = null;
    await rename(temporary, filename);
  } finally {
    await file?.close();
    await rm(temporary, { force: true }).catch(() => {});
  }
}
