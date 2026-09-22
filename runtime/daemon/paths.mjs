import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rename, rm, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

export const PROTOCOL = 1;
export const MAX_IPC_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const uid = () => process.getuid?.();
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const runtimeError = (code) => Object.assign(new Error(code), { code });

// Callers resolve the project first; a nested working directory is not a base.
export function defaultDataDir(projectRoot = process.cwd()) {
  return path.resolve(process.env.GRAPHLIN_DATA_DIR || path.join(projectRoot, '.graphlin'));
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

// Resolve parent aliases before the leaf exists so hooks and startup agree.
async function resolveFuture(value) {
  try { return await realpath(value); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await resolveFuture(parent), path.basename(value));
  }
}

async function checkLocalDirectory(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid() !== undefined && stat.uid !== uid())) {
      throw runtimeError('unsafe_data_directory');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function hasGitIndex(root, marker) {
  let directory = path.join(root, '.git'), file;
  try {
    if (marker.isFile()) {
      file = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = await file.stat(), bytes = Buffer.alloc(8193);
      if (!stat.isFile() || stat.size > 8192) throw runtimeError('tracked_state_directory');
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(bytes.subarray(0, bytesRead).toString('utf8'));
      if (bytesRead !== stat.size || !match) throw runtimeError('tracked_state_directory');
      // Worktrees and separate Git directories keep their index at this target.
      directory = path.resolve(root, match[1]);
    } else if (!marker.isDirectory()) throw runtimeError('tracked_state_directory');
    try { await lstat(path.join(directory, 'index')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  } finally { await file?.close(); }
}

async function requireUntrackedState(root, marker) {
  try {
    const { error, stdout } = await new Promise(resolve => {
      execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null', 'ls-files', '--cached', '-z', '--', '.graphlin'], {
        cwd: root, shell: false, timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8',
        // Never inherit an alternate index/worktree or commands from Git's environment.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
      }, (error, stdout) => resolve({ error, stdout }));
    });
    // Ignores never protect already tracked files, including missing worktree
    // files that a later write would recreate. No index or file is changed here.
    if (stdout || (error && await hasGitIndex(root, marker))) throw runtimeError('tracked_state_directory');
    // A minimal demo boundary may lack both Git and an index. Otherwise an
    // unavailable, corrupt, oversized or timed-out index check fails closed.
  } catch { throw runtimeError('tracked_state_directory'); }
}

async function appendIgnoreRule(filename, rule, retries = 3) {
  let file;
  try {
    // Append through the checked descriptor; never truncate or replace a user's
    // ignore file, follow a symlink, or change another hard link's contents.
    file = await open(filename, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    const before = await file.stat();
    const safe = stat => stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024 &&
      (uid() === undefined || stat.uid === uid());
    const sameFile = stat => safe(stat) && !stat.isSymbolicLink() &&
      stat.dev === before.dev && stat.ino === before.ino;
    if (!safe(before)) throw runtimeError('unsafe_ignore_file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!sameFile(await lstat(filename))) throw runtimeError('unsafe_ignore_file');
    if (length !== before.size) {
      // Another starter may append between fstat and read. Reread that same
      // safe file rather than treating normal setup contention as corruption.
      await file.close(); file = null;
      if (retries) return appendIgnoreRule(filename, rule, retries - 1);
      throw runtimeError('unsafe_ignore_file');
    }
    const text = bytes.subarray(0, length).toString('utf8');
    const lines = text.split(/\r?\n/), prior = lines.lastIndexOf(rule);
    // A later negation can reopen the state directory. Reassert protection at
    // the end without editing any existing rule.
    if (prior < 0 || lines.slice(prior + 1).some(line => line.startsWith('!'))) {
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const prefix = !length || text.endsWith('\n') ? '' : text.endsWith('\r') ? '\n' : newline;
      await file.writeFile(`${prefix}${rule}${newline}`);
      await file.sync();
    }
    if (!sameFile(await lstat(filename))) throw runtimeError('unsafe_ignore_file');
  } catch { throw runtimeError('unsafe_ignore_file'); }
  finally { await file?.close(); }
}

const localPreparations = new Map();
function prepareLocalStorage(root, requested, base) {
  const prior = localPreparations.get(base) ?? Promise.resolve();
  const operation = prior.catch(() => {}).then(async () => {
    let git;
    try { git = await lstat(path.join(root, '.git')); }
    catch (error) { if (error.code !== 'ENOENT') throw runtimeError('project_unavailable'); }
    if (git) await requireUntrackedState(root, git);
    if (git?.isFile() || git?.isDirectory()) await appendIgnoreRule(path.join(root, '.gitignore'), '/.graphlin/');
    await privateDirectory(requested);
    // Standalone projects remain protected if Git is initialized later, too.
    await appendIgnoreRule(path.join(base, '.gitignore'), '*');
  });
  localPreparations.set(base, operation);
  return operation.finally(() => {
    if (localPreparations.get(base) === operation) localPreparations.delete(base);
  });
}

export async function projectPaths(projectRoot, dataDir, { create = false } = {}) {
  if (process.platform === 'win32') throw runtimeError('unsupported_platform');
  const root = await canonicalProjectRoot(projectRoot);
  const requested = path.resolve(dataDir === undefined ? defaultDataDir(root) : dataDir);
  const local = path.join(root, '.graphlin');
  const requestedLeaf = path.join(await resolveFuture(path.dirname(requested)), path.basename(requested));
  // Check before realpath can hide a .graphlin symlink, including dangling ones.
  if (requestedLeaf === local) await checkLocalDirectory(requested);
  const base = await resolveFuture(requested);
  if (base === local) await checkLocalDirectory(requested);
  if (create) {
    if (base === local) await prepareLocalStorage(root, requested, base);
    else await privateDirectory(requested);
  }
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
