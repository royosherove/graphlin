#!/usr/bin/env node
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, securityRepository, setupSecurityScanner, verifyScanner, printSecurityFailure } from './security-check.mjs';

const hooks = ['pre-commit', 'commit-msg'];
const conflict = () => Object.assign(new Error('security_hooks_conflict'), { code: 'security_hooks_conflict' });

// Installation is explicit. Never change core.hooksPath or replace another hook.
export async function installSecurityHooks({ projectRoot = process.cwd(), fetchFile } = {}) {
  const repo = await securityRepository(projectRoot);
  // Unlike scans, installation must see an existing global/system hook manager.
  // Read only this effective setting; never mutate any Git configuration.
  const configEnv = Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
  const configured = await runTool('git', ['config', '--get', 'core.hooksPath'], { cwd: repo.root, env: configEnv });
  if (configured.code !== 1) throw conflict();
  const directory = path.join(path.dirname(repo.toolDir), 'hooks');
  const wanted = await Promise.all(hooks.map(async name => ({
    filename: path.join(directory, name),
    body: await readFile(new URL(`../.githooks/${name}`, import.meta.url)),
  })));
  for (const item of wanted) {
    try {
      const stat = await lstat(item.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          !(stat.mode & 0o111) || !(await readFile(item.filename)).equals(item.body)) throw conflict();
      item.exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw conflict();
  await setupSecurityScanner(repo.toolDir, { fetchFile });
  await verifyScanner(path.join(repo.toolDir, 'git-secrets'));
  const created = [];
  try {
    for (const item of wanted.filter(item => !item.exists)) {
      const file = await open(item.filename, 'wx', 0o755);
      try {
        created.push({ filename: item.filename, stat: await file.stat() });
        await file.writeFile(item.body);
        await file.sync();
      } finally { await file.close(); }
    }
  } catch {
    // Roll back only files this invocation created, never a racing replacement.
    for (const item of created) {
      const stat = await lstat(item.filename).catch(() => null);
      if (stat?.ino === item.stat.ino && stat?.dev === item.stat.dev) await unlink(item.filename);
    }
    throw conflict();
  }
  return { installed: hooks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw conflict();
    await installSecurityHooks();
    console.log('AWS security hooks installed for staged files and commit messages.');
  } catch (error) {
    if (error.code === 'security_hooks_conflict') {
      console.error('Existing hooks or core.hooksPath were preserved. Chain .githooks/pre-commit and .githooks/commit-msg from your hook manager explicitly.');
    } else printSecurityFailure(error);
    process.exitCode = 1;
  }
}
