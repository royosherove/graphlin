import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safeText } from '../core/privacy.mjs';

const TTL_MS = 2000;
const GIT_TIMEOUT_MS = 2000;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const BRANCH = ['symbolic-ref', '--quiet', '--short', 'HEAD'];
const HEAD = ['rev-parse', '--verify', '--end-of-options', 'HEAD'];
const validBranch = value => safeText(value, 240) && !CONTROLS.test(value) &&
  !/[<>\\:\s]/.test(value) && !value.startsWith('/') && !value.startsWith('-');

/** Local ref metadata only. The caller owns reconciliation and model updates. */
export function createLineageReader({ projectRoot, projectId, execute = execFile } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) ||
      Buffer.byteLength(projectRoot) > 4096 || projectRoot.includes('\0') ||
      typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(projectId) ||
      typeof execute !== 'function') throw new TypeError('invalid_lineage_options');
  let cached, confirmed, expiresAt = 0, pending;
  const result = (status, branch, head) => Object.freeze({
    id: createHash('sha256').update(JSON.stringify([projectId, status, branch ?? null, head ?? null])).digest('hex'),
    status, ...(branch ? { branch } : {}), ...(head ? { head } : {}),
  });

  function git(args) {
    return new Promise(resolve => {
      let child, grace, settled = false;
      const finish = value => {
        if (!settled) { settled = true; clearTimeout(timer); clearImmediate(grace); resolve(value); }
      };
      const timer = setTimeout(() => {
        // A busy parent can process an expired timer before an already-finished
        // child's I/O/close callbacks. Let those callbacks drain before killing.
        grace = setImmediate(() => { grace = setImmediate(() => {
          if (settled) return;
          finish({ status: 'unavailable' });
          try { child?.kill?.('SIGKILL'); } catch { /* No child details leave the reader. */ }
        }); });
      }, GIT_TIMEOUT_MS);
      try {
        child = execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
          cwd: projectRoot, shell: false, timeout: 0, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8',
          env: { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
        }, (error, stdout, stderr) => {
          const text = typeof stdout === 'string' ? stdout.replace(/\r?\n$/, '') : '';
          if (!error) return finish({ status: 'ok', text });
          if (!error.killed && error.code === 1 && !text && args === BRANCH) return finish({ status: 'detached' });
          finish({ status: !error.killed && error.code === 128 && typeof stderr === 'string' &&
            stderr.includes('not a git repository') ? 'not_git' : 'unavailable' });
        });
      } catch { finish({ status: 'unavailable' }); }
    });
  }

  async function readRefs() {
    if (CONTROLS.test(projectRoot)) return result('unavailable');
    const branch = await git(BRANCH);
    if (branch.status === 'not_git') return result('not_git');
    if (branch.status !== 'detached' && (branch.status !== 'ok' || !validBranch(branch.text))) return result('unavailable');
    const head = await git(HEAD);
    if (head.status !== 'ok' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.text)) return result('unavailable');
    // Do not combine a branch observed before checkout with another branch's HEAD.
    const after = await git(BRANCH);
    if (branch.status !== after.status || branch.text !== after.text) return result('unavailable');
    return result('git', branch.status === 'ok' ? branch.text : undefined, head.text);
  }

  return async function read() {
    if (cached && Date.now() < expiresAt) return cached;
    if (!pending) pending = readRefs().then(value => {
      if (value.status !== 'unavailable') confirmed = value;
      // Git is optional: initial uncertainty carries no Git authority. Losing
      // a previously confirmed identity instead pauses runtime admission.
      cached = value.status === 'unavailable'
        ? confirmed ? Object.freeze({ ...confirmed, status: 'unavailable' }) : result('unknown')
        : value;
      expiresAt = Date.now() + TTL_MS;
      return cached;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
