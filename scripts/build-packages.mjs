#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, lstat, writeFile, rm, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { publicPackageFiles, validatePackage } from './validate-packages.mjs';

const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_DIRECTORIES = ['.claude-plugin', '.codex-plugin', 'skills', 'scripts', 'runtime', 'schemas', 'adapters'];
const PROTECTED_DIRECTORIES = [...SOURCE_DIRECTORIES, 'docs', 'node_modules'];

async function assertDestination(destination, { directory = false } = {}) {
  const absolute = path.resolve(destination), root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('package_destination_symlink_rejected');
    if ((i < components.length - 1 || directory) && !info.isDirectory()) {
      throw new Error('invalid_package_destination');
    }
  }
}
async function destinationDirectory(directory) {
  await assertDestination(directory, { directory: true });
  await mkdir(directory, { recursive: true });
  await assertDestination(directory, { directory: true });
}
async function publishFile(filename, contents) {
  await assertDestination(filename);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}-${randomUUID()}.tmp`);
  try {
    // The exclusive temporary write cannot truncate a linked destination.
    // Rename replaces a directory entry and never follows the final symlink.
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o644 });
    await assertDestination(filename);
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

async function assertSourceTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('package_symlink_rejected');
    if (entry.isDirectory()) await assertSourceTree(name);
  }
}
async function copy(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('package_symlink_rejected');
  if (info.isDirectory()) await assertSourceTree(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false });
}
export async function buildPackages({ outputDir = path.join(SOURCE, 'dist'), sourceDir = SOURCE } = {}) {
  const source = path.resolve(sourceDir), output = path.resolve(outputDir);
  if (output === source || source.startsWith(`${output}${path.sep}`)) throw new Error('unsafe_output_directory');
  if (PROTECTED_DIRECTORIES.some(file => output === path.join(source, file) || output.startsWith(`${path.join(source, file)}${path.sep}`))) {
    throw new Error('unsafe_output_directory');
  }
  // Preflight every output before replacing even the first generated profile.
  // Parent links are rejected too, including links above outputDir.
  await assertDestination(output, { directory: true });
  for (const profile of ['portable', 'claude', 'codex']) {
    const target = path.join(output, profile, 'graphlin');
    await assertDestination(target, { directory: true });
    await assertDestination(path.join(target, '.graphlin-package'));
  }
  const kiro = path.join(output, 'kiro');
  await assertDestination(kiro, { directory: true });
  await assertDestination(path.join(kiro, 'profile.json'));
  await assertDestination(path.join(kiro, 'README.md'));
  const marketplaceDirectory = path.join(output, 'codex', '.agents', 'plugins');
  const marketplaceFile = path.join(marketplaceDirectory, 'marketplace.json');
  await assertDestination(marketplaceDirectory, { directory: true });
  await assertDestination(marketplaceFile);
  const files = await publicPackageFiles(source);
  for (const directory of SOURCE_DIRECTORIES) {
    const filename = path.join(source, directory), info = await lstat(filename);
    if (info.isSymbolicLink()) throw new Error('package_symlink_rejected');
    await assertSourceTree(filename);
  }
  await validatePackage(source);
  await destinationDirectory(output);
  const built = [];
  for (const profile of ['portable', 'claude', 'codex']) {
    const parent = path.join(output, profile), target = path.join(parent, 'graphlin');
    await destinationDirectory(parent);
    const temporary = path.join(parent, `.graphlin-${randomUUID()}`);
    await mkdir(temporary);
    try {
      const profileFiles = files.filter(file => profile === 'claude' || file !== '.claude-plugin/plugin.json');
      // publicPackageFiles includes every reviewed file of the full pinned
      // parser under Graphlin's own node_modules. Never resolve a hoisted or
      // inspected-project dependency, and never copy an arbitrary dependency tree.
      for (const file of profileFiles) await copy(path.join(source, file), path.join(temporary, file));
      const metadata = JSON.parse(await readFile(path.join(temporary, 'package.json'), 'utf8'));
      metadata.files = metadata.files.filter(file => profileFiles.includes(file.slice(2)));
      // Generated plugins are runnable distributions. Checkout-only testing,
      // evaluation, packaging, and release commands would point to absent files.
      metadata.scripts = Object.fromEntries(['start', 'demo', 'doctor', 'validate', 'prepack']
        .filter(name => metadata.scripts[name]).map(name => [name, metadata.scripts[name]]));
      await writeFile(path.join(temporary, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      if (profile === 'codex') {
        await writeFile(path.join(temporary, '.mcp.json'), `${JSON.stringify({
          mcpServers: { graphlin: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/control.mjs'] } },
        }, null, 2)}\n`);
      }
      if (profile === 'portable') {
        const manifest = JSON.parse(await readFile(path.join(temporary, 'plugin.json'), 'utf8'));
        delete manifest.extensions;
        await writeFile(path.join(temporary, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      }
      for (const file of ['collect.sh', 'graphlin.mjs', 'control.mjs']) {
        await chmod(path.join(temporary, 'scripts', file), 0o755);
      }
      await writeFile(path.join(temporary, 'PACKAGE-NOTES.md'),
        `# Graphlin ${profile} package\n\nNode.js 22.14+; macOS/Linux. Self-contained runtime and parser bundle; no dependency install.\n` +
        'Run scripts/graphlin.mjs --help for local controls. This package does not install itself.\n' +
        'Hook activation/trust has not been certified. Kiro is inactive and experimental.\n' +
        'See adapters/README.md and skills/graphlin/SKILL.md for privacy and coverage.\n');
      await validatePackage(temporary);
      await assertDestination(target, { directory: true });
      await assertDestination(path.join(target, '.graphlin-package'));
      const exists = await lstat(target).catch(() => null);
      if (exists) {
        if (exists.isSymbolicLink() || (await readFile(path.join(target, '.graphlin-package'), 'utf8').catch(() => '')) !== profile) {
          throw new Error('unmanaged_output_directory');
        }
        await rm(target, { recursive: true, force: true });
      }
      await writeFile(path.join(temporary, '.graphlin-package'), profile);
      await assertDestination(target, { directory: true });
      await rename(temporary, target);
      built.push({ profile, directory: target });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await destinationDirectory(kiro);
  await publishFile(path.join(kiro, 'profile.json'), await readFile(path.join(source, 'adapters/kiro/profile.json')));
  await publishFile(path.join(kiro, 'README.md'), '# Kiro: inactive experimental profile\n\nNo active hooks or installable plugin are generated. See profile.json.\n');
  await destinationDirectory(marketplaceDirectory);
  await publishFile(marketplaceFile, `${JSON.stringify({
    name: 'graphlin-local',
    interface: { displayName: 'Graphlin local' },
    plugins: [{
      name: 'graphlin',
      source: { source: 'local', path: './graphlin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  }, null, 2)}\n`);
  return built;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || !['--out', '--output'].includes(args[0]))) throw new Error('invalid_arguments');
    const result = await buildPackages(args.length ? { outputDir: args[1] } : {});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch { process.stderr.write('Graphlin package generation failed.\n'); process.exitCode = 1; }
}
