#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Review upstream changes and update all three hashes together. Scans never download.
export const SCANNER_REVISION = '7d6b970cbd3c216353cb22b383b70c150140662e';
export const GITLEAKS_VERSION = '8.30.1';
// Public checksum of the pinned upstream script, not a credential.
const SCANNER_SHA256 = '775e3f0d2f2f8e4b5922115f1235f7369805de76f4efc69cb674bcba5590d0fa';
const FILES = {
  'git-secrets': SCANNER_SHA256,
  'LICENSE.txt': 'e7a0682a9b197d61a49d949642aac96280842e241d72ff13b2179d37b90d3fda',
  'NOTICE.txt': '4c6de397120340ca2656f1f54f677d005846467e27bd27e056a3ed0a288efe2e',
};
const MAX_OUTPUT = 16 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const baseEnv = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
});
const gitOptions = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.quotePath=false', '-c', 'log.showSignature=false'];
// Upstream history uses git log -G. Keep that read from executing a repository's
// diff/textconv program; scanner code and all arguments remain separately quoted.
const scannerShell = `git() {
  if [ "$1" = log ]; then shift; command git -c log.showSignature=false log --no-ext-diff --no-textconv "$@";
  else command git "$@"; fi
}
source "$1" "\${@:2}"`;

// Raw tool output stays in memory and never becomes an exception or console log.
export function runTool(command, args, { cwd, env = baseEnv(), timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout, killSignal: 'SIGKILL', shell: false,
      maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && !Number.isInteger(error.code)) return reject(fail('security_check_unavailable'));
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}
export async function securityGit(root, args, env = baseEnv()) {
  const result = await runTool('git', [...gitOptions, ...args], { cwd: root, env });
  if (result.code) throw fail('security_check_unavailable');
  return result.stdout;
}
export async function securityRepository(cwd = process.cwd()) {
  const root = (await securityGit(cwd, ['rev-parse', '--show-toplevel'])).trimEnd();
  const gitDir = (await securityGit(root, ['rev-parse', '--absolute-git-dir'])).trimEnd();
  const common = (await securityGit(root, ['rev-parse', '--git-common-dir'])).trimEnd();
  // Git commit --only uses a temporary index; inspect the index Git will commit.
  const env = { ...baseEnv(), ...(process.env.GIT_INDEX_FILE ? { GIT_INDEX_FILE: process.env.GIT_INDEX_FILE } : {}) };
  const index = (await securityGit(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], env)).trimEnd();
  return { root, gitDir, index, toolDir: path.resolve(root, common, 'graphlin-security') };
}

async function checkedBytes(filename, limit = 64 * 1024) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw fail('security_tool_integrity');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw fail('security_tool_integrity');
    return bytes.subarray(0, bytesRead);
  } catch { throw fail('security_tool_integrity'); }
  finally { await file?.close(); }
}
export async function verifyScanner(filename) {
  const bytes = await checkedBytes(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== FILES['git-secrets']) throw fail('security_tool_integrity');
  return filename;
}

export async function setupSecurityScanner(directory, { fetchFile = fetch } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('security_tool_integrity');
  for (const [name, digest] of Object.entries(FILES)) {
    const filename = path.join(directory, name);
    let bytes;
    try { await lstat(filename); bytes = await checkedBytes(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes) {
      const response = await fetchFile(`https://raw.githubusercontent.com/awslabs/git-secrets/${SCANNER_REVISION}/${name}`,
        { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw fail('security_download_failed');
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 64 * 1024) throw fail('security_download_failed');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw fail('security_tool_integrity');
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw fail('security_tool_integrity');
  }
  return path.join(directory, 'git-secrets');
}

const AWS_RULES = ['aws-access-key-id', 'aws-bedrock-long-lived', 'aws-bedrock-short-lived',
  'aws-secret-access-key', 'aws-account-id'];
// Filenames are untrusted too. Never print a credential embedded in a name,
// terminal controls, private directory names, or a history author identity.
export const securityFileId = name => `file-${createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
function grepFindings(output, rule, messageName) {
  const findings = [];
  // Git's -z separates filenames and line numbers from matched content. Never
  // parse "file:line:secret" output: colons/newlines in names make that ambiguous.
  let offset = 0;
  while (offset < output.length) {
    const endName = output.indexOf('\0', offset), endLine = output.indexOf('\0', endName + 1);
    const endText = output.indexOf('\n', endLine + 1);
    if (endName < offset || endLine < endName || endText < endLine) throw fail('security_check_unavailable');
    const file = securityFileId(messageName ?? output.slice(offset, endName));
    const line = Number(output.slice(endName + 1, endLine));
    if (!Number.isSafeInteger(line) || line < 1) throw fail('security_check_unavailable');
    findings.push({ file, rule, line });
    offset = endText + 1;
    if (findings.length > 10_000) throw fail('security_check_unavailable');
  }
  return findings;
}

export async function checkSecurity({ projectRoot = process.cwd(), mode = 'staged', messageFile,
  scannerPath } = {}) {
  if (!['staged', 'history', 'commit-msg'].includes(mode)) throw fail('security_usage');
  const repo = await securityRepository(projectRoot);
  const scanner = await verifyScanner(scannerPath ?? path.join(repo.toolDir, 'git-secrets'));
  const temporary = await mkdtemp(path.join(tmpdir(), 'graphlin-security-'));
  const findings = [];
  try {
    // Only `git config` uses GIT_CONFIG. Other Git commands read the real index
    // and objects, but use an empty working tree so .gitallowed cannot bypass CI.
    const env = { ...baseEnv(), HOME: temporary, GIT_DIR: repo.gitDir, GIT_WORK_TREE: temporary,
      GIT_INDEX_FILE: repo.index, GIT_CONFIG: path.join(temporary, 'config'),
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'core.quotePath', GIT_CONFIG_VALUE_2: 'false' };
    const tool = args => runTool('bash', ['-c', scannerShell, 'graphlin-git-secrets', scanner, ...args], { cwd: temporary, env });
    if ((await tool(['--register-aws'])).code) throw fail('security_check_unavailable');
    const patterns = (await securityGit(temporary, ['config', '--get-all', 'secrets.patterns'], env))
      .trimEnd().split('\n').map(pattern => pattern.replaceAll('\\s', '[[:space:]]'));
    if (patterns.length !== 5 || patterns.some(pattern => !pattern)) throw fail('security_check_unavailable');
    // Keep only upstream regexes: no provider or allowed/example rules. POSIX
    // whitespace also works with macOS Git, whose ERE does not recognize \s.
    await writeFile(env.GIT_CONFIG, `[secrets]\n${patterns.map(pattern => `\tpatterns = ${JSON.stringify(pattern)}\n`).join('')}`,
      { mode: 0o600 });
    const combined = patterns.join('|');
    async function locations(grepArgs, messageName) {
      const rows = [];
      for (const [index, pattern] of patterns.entries()) {
        const details = await runTool('git', [...gitOptions, 'grep', '-znwHEI', '-e', pattern, ...grepArgs],
          { cwd: temporary, env });
        if (![0, 1].includes(details.code)) throw fail('security_check_unavailable');
        rows.push(...grepFindings(details.stdout, AWS_RULES[index], messageName));
      }
      return rows;
    }
    async function scan(args, grepArgs, messageName) {
      const result = await tool(args);
      if (result.code === 0) return;
      if (result.code !== 1) throw fail('security_check_unavailable');
      const rows = await locations(grepArgs, messageName);
      if (!rows.length) throw fail('security_check_unavailable');
      findings.push(...rows);
    }
    async function scanMessage(body, name) {
      const filename = path.join(temporary, 'message');
      await writeFile(filename, body, { mode: 0o600 });
      await scan(['--scan', '--no-index', '--', 'message'], ['--no-index', '--', 'message'], name);
    }
    if (mode === 'staged') await scan(['--scan', '--cached'], ['--cached']);
    else if (mode === 'commit-msg') {
      if (typeof messageFile !== 'string') throw fail('security_usage');
      await scanMessage(await checkedBytes(path.resolve(projectRoot, messageFile), 1024 * 1024), 'COMMIT_EDITMSG');
    } else {
      if ((await securityGit(repo.root, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') {
        throw fail('security_shallow_history');
      }
      const history = await tool(['--scan-history']);
      if (history.code !== 0) {
        if (history.code !== 1) throw fail('security_check_unavailable');
        const revisions = (await securityGit(temporary,
          ['log', '--all', '--no-ext-diff', '--no-textconv', `-G${combined}`, '--format=%H'], env)).trim().split('\n');
        if (!revisions.length || revisions.some(value => !/^[a-f0-9]{40,64}$/.test(value))) throw fail('security_check_unavailable');
        for (let i = 0; i < revisions.length; i += 128) {
          findings.push(...await locations([...revisions.slice(i, i + 128), '--']));
        }
        if (!findings.length) throw fail('security_check_unavailable');
      }
      // Upstream --scan-history scans file contents, not historical commit messages.
      const messages = await securityGit(temporary, ['log', '--all', '--format=%H%x00%B%x00'], env);
      const parts = messages.split('\0');
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const revision = parts[i].trim();
        if (!/^[a-f0-9]{40,64}$/.test(revision)) throw fail('security_check_unavailable');
        await scanMessage(parts[i + 1], `${revision}:COMMIT_EDITMSG`);
      }
    }
    return findings;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function checkGenericSecurity({ projectRoot = process.cwd(), scannerPath } = {}) {
  if (typeof scannerPath !== 'string' || !path.isAbsolute(scannerPath)) throw fail('security_usage');
  const repo = await securityRepository(projectRoot);
  if ((await securityGit(repo.root, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') {
    throw fail('security_shallow_history');
  }
  const version = await runTool(scannerPath, ['version']);
  if (version.code || version.stdout.trim() !== GITLEAKS_VERSION) throw fail('security_tool_integrity');
  const temporary = await mkdtemp(path.join(tmpdir(), 'graphlin-gitleaks-'));
  try {
    const config = path.join(temporary, 'config.toml'), ignore = path.join(temporary, '.gitleaksignore');
    const report = path.join(temporary, 'report.json');
    // Explicit built-in defaults; neither repository configuration nor inline
    // allowances/fingerprint baselines may suppress the required CI scan.
    await writeFile(config, '[extend]\nuseDefault = true\n', { mode: 0o600 });
    await writeFile(ignore, '', { mode: 0o600 });
    const result = await runTool(scannerPath, ['git', repo.root, '--log-opts=--all --full-history --no-ext-diff --no-textconv --no-show-signature',
      '--config', config, '--gitleaks-ignore-path', ignore, '--ignore-gitleaks-allow',
      '--no-banner', '--no-color', '--redact=100', '--timeout=120',
      '--report-format=json', '--report-path', report], { cwd: temporary, env: { ...baseEnv(), HOME: temporary } });
    if (![0, 1].includes(result.code)) throw fail('security_check_unavailable');
    const rows = JSON.parse((await checkedBytes(report, MAX_OUTPUT)).toString('utf8'));
    if (!Array.isArray(rows) || rows.length > 10_000 || (result.code === 1 && !rows.length)) {
      throw fail('security_check_unavailable');
    }
    return rows.map(row => {
      if (typeof row.File !== 'string' || typeof row.RuleID !== 'string' ||
          !Number.isSafeInteger(row.StartLine) || row.StartLine < 1) throw fail('security_check_unavailable');
      // Do not forward descriptions, excerpts, authors, emails, or matched values.
      if (!/^[a-z0-9-]{1,80}$/.test(row.RuleID)) throw fail('security_check_unavailable');
      return { file: securityFileId(row.File), rule: row.RuleID, line: row.StartLine };
    });
  } catch { throw fail('security_check_unavailable'); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

export const SECURITY_MESSAGES = {
  security_tool_integrity: 'Pinned git-secrets is missing or changed. Run node scripts/security-check.mjs setup.',
  security_download_failed: 'Could not download the pinned security tool. No hooks were activated.',
  security_check_unavailable: 'Security check could not complete; the operation is blocked.',
  security_shallow_history: 'History scan needs a complete checkout (fetch-depth: 0).',
  security_usage: 'Use security-check.mjs setup, staged, history, commit-msg <message-file>, or generic-history <absolute-gitleaks-path>.',
};
export function printSecurityFailure(error) {
  console.error(SECURITY_MESSAGES[error?.code] ?? SECURITY_MESSAGES.security_check_unavailable);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = 'staged', messageFile, ...extra] = process.argv.slice(2);
    if (extra.length || (!['commit-msg', 'generic-history'].includes(mode) && messageFile)) throw fail('security_usage');
    if (mode === 'setup') {
      await setupSecurityScanner((await securityRepository()).toolDir);
      console.log('Pinned AWS git-secrets ready. Hooks are not activated.');
    } else {
      const findings = mode === 'generic-history'
        ? await checkGenericSecurity({ scannerPath: messageFile }) : await checkSecurity({ mode, messageFile });
      for (const row of findings) console.error(JSON.stringify(row));
      if (findings.length) process.exitCode = 1;
      else console.log('Security check passed.');
    }
  } catch (error) { printSecurityFailure(error); process.exitCode = 1; }
}
