#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const PARSER_NAME = '@vscode/tree-sitter-wasm';
const PARSER_VERSION = '0.3.1';
// The complete published 0.3.1 package, not a pruned grammar subset. Keep this
// explicit: arbitrary new files under node_modules must never enter a release.
const PARSER_FILES = [
  'LICENSE', 'README.md', 'SECURITY.md', 'cgmanifest.json', 'package.json',
  'wasm/tree-sitter.js', 'wasm/tree-sitter.wasm', 'wasm/web-tree-sitter.d.ts',
  ...['bash', 'c-sharp', 'cpp', 'css', 'go', 'ini', 'java', 'javascript', 'php',
    'powershell', 'python', 'regex', 'ruby', 'rust', 'tsx', 'typescript']
    .map(language => `wasm/tree-sitter-${language}.wasm`),
];
const SDK_EXPORTS = {
  './extensions/sdk': {
    types: './runtime/extensions/sdk.d.ts',
    import: './runtime/extensions/sdk.mjs',
    default: './runtime/extensions/sdk.mjs',
  },
  './extensions/scene': './runtime/extensions/scene.mjs',
};

async function assertRegularFile(root, file) {
  let current = root;
  for (const component of file.split('/')) {
    current = path.join(current, component);
    assert.equal((await lstat(current)).isSymbolicLink(), false, 'package_symlink_rejected');
  }
  assert.ok((await lstat(current)).isFile(), 'package_file_must_be_regular');
}

export async function bundledPackageFiles(root, metadata) {
  metadata ??= JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(metadata.bundledDependencies, [PARSER_NAME], 'parser_bundle_required');
  assert.equal(metadata.dependencies?.[PARSER_NAME], PARSER_VERSION, 'parser_dependency_must_be_pinned');
  const base = `node_modules/${PARSER_NAME}`;
  await assertRegularFile(root, `${base}/package.json`);
  const parser = JSON.parse(await readFile(path.join(root, base, 'package.json'), 'utf8'));
  assert.equal(parser.name, PARSER_NAME, 'unexpected_parser_package');
  assert.equal(parser.version, PARSER_VERSION, 'unexpected_parser_version');
  assert.equal(parser.license, 'MIT', 'unexpected_parser_license');
  assert.deepEqual(Object.keys(parser.dependencies ?? {}), [], 'unexpected_parser_dependencies');
  const files = PARSER_FILES.map(file => `${base}/${file}`);
  for (const file of files) await assertRegularFile(root, file);
  return files;
}

// Dependency-free checks for this package's deliberately small manifest profile.
// This is not a replacement for a host's schema validation or activation/trust.
export async function publicPackageFiles(root) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0, 'package_files_required');
  const files = ['package.json', ...metadata.files.map(file => {
    // npm treats an unanchored filename such as README.md as a match in
    // descendants too. Anchor every entry to the package root explicitly.
    assert.ok(typeof file === 'string' && file.startsWith('./'), 'package_file_must_be_root_anchored');
    return file.slice(2);
  })];
  assert.equal(new Set(files).size, files.length, 'duplicate_package_file');
  for (const file of files) {
    // Exact filenames only: no wildcard or directory can silently sweep newly
    // created credentials, local state, research, or operational material in.
    assert.ok(typeof file === 'string' && file.length > 0 && !file.includes('\\') &&
      !path.posix.isAbsolute(file) && !/[*?[\]{}!\u0000-\u001f]/.test(file) &&
      file.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid_package_file');
    assert.ok(/^(?:package\.json|LICENSE|README\.md|plugin\.json|mcp\.json|\.mcp\.json|\.claude-plugin\/plugin\.json|\.codex-plugin\/plugin\.json|adapters\/(?:README\.md|(?:claude|codex|kiro)\/(?:hooks|profile)\.json)|skills\/graphlin\/SKILL\.md|runtime\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:mjs|js|css|html|d\.ts)|docs\/(?:decision-service|extension-authoring|model-api|visualizer-views|usage)\.md|schemas\/[a-z0-9-]+\.schema\.json|scripts\/(?:arguments|build-packages|collector|control|daemon|extensions|graphlin|onboarding|validate-packages)\.mjs|scripts\/collect\.sh)$/.test(file),
    'unexpected_public_package_file');
    await assertRegularFile(root, file);
  }
  return [...files, ...await bundledPackageFiles(root, metadata)];
}

export async function validatePackage(root) {
  const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const metadata = await json('package.json');
  await bundledPackageFiles(root, metadata);
  assert.deepEqual(metadata.exports, SDK_EXPORTS, 'invalid_sdk_exports');
  for (const file of ['runtime/extensions/sdk.mjs', 'runtime/extensions/sdk.d.ts', 'runtime/extensions/scene.mjs']) {
    assert.ok(metadata.files.includes(`./${file}`), 'sdk_export_must_be_packaged');
    await assertRegularFile(root, file);
  }
  const manifest = await json('plugin.json'), portable = await json('mcp.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'graphlin');
  assert.match(manifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  assert.equal(metadata.license, 'MIT');
  // npm's publish normalization removes "./" from bin targets. This is
  // separate from the files allowlist, whose root anchors must be preserved.
  assert.deepEqual(metadata.bin, { graphlin: 'scripts/graphlin.mjs' });
  assert.equal(metadata.repository?.url, 'git+https://github.com/royosherove/graphlin.git');
  assert.deepEqual(metadata.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' });
  assert.match(await readFile(path.join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.match(await readFile(path.join(root, 'scripts/graphlin.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0);
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(portable.mcpServers), ['graphlin']);
  assert.deepEqual(portable.mcpServers.graphlin, {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/scripts/control.mjs'], cwd: '${PLUGIN_DATA}',
  });
  const compatibility = await json('.codex-plugin/plugin.json');
  assert.equal(compatibility.name, manifest.name);
  assert.equal(compatibility.version, manifest.version);
  assert.equal(compatibility.skills, './skills/');
  assert.equal(compatibility.mcpServers, './.mcp.json');
  assert.ok(compatibility.author?.name);
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    assert.ok(typeof compatibility.interface?.[field] === 'string' && compatibility.interface[field].length);
  }
  assert.ok(Array.isArray(compatibility.interface.defaultPrompt));
  const claudePath = path.join(root, '.claude-plugin/plugin.json');
  if (await lstat(claudePath).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    const claude = await json('.claude-plugin/plugin.json');
    assert.equal(claude.name, manifest.name);
    assert.equal(claude.version, manifest.version);
    assert.equal(claude.license, 'MIT');
    assert.equal(claude.hooks, './adapters/claude/hooks.json');
  }
  const legacy = await json('.mcp.json');
  assert.deepEqual(Object.keys(legacy.mcpServers), ['graphlin']);
  assert.equal(legacy.mcpServers.graphlin.command, 'node');
  assert.ok(['${CLAUDE_PLUGIN_ROOT}/scripts/control.mjs', '${PLUGIN_ROOT}/scripts/control.mjs']
    .includes(legacy.mcpServers.graphlin.args[0]));
  const skill = await readFile(path.join(root, 'skills/graphlin/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: graphlin\ndescription: [^\n]+\n---\n/);
  for (const file of ['scripts/control.mjs', 'scripts/graphlin.mjs', 'scripts/collect.sh',
    'runtime/daemon/server.mjs', 'runtime/collector/index.mjs', 'runtime/pipeline.mjs', 'runtime/web/index.html']) {
    assert.ok((await lstat(path.join(root, file))).isFile());
  }
  for (const host of ['claude', 'codex']) {
    const profile = await json(`adapters/${host}/profile.json`), config = await json(`adapters/${host}/hooks.json`);
    assert.deepEqual(Object.keys(config.hooks).sort(), [...profile.events].sort());
    assert.equal(profile.activation, 'not_verified');
    for (const group of Object.values(config.hooks)) for (const rule of group) for (const hook of rule.hooks) {
      assert.equal(hook.type, 'command');
      assert.equal(hook.timeout, 2);
      assert.match(hook.command, /if \[ -r /);
      assert.match(hook.command, />\/dev\/null 2>&1; exit 0$/);
      assert.ok(hook.command.includes(`/scripts/collect.sh"`));
      assert.equal(hook.async, undefined);
    }
  }
  if (manifest.extensions) {
    assert.equal(manifest.extensions['com.openai'].hooks, './adapters/codex/hooks.json');
    assert.ok(manifest.extensions['com.openai'].interface.displayName);
  }
  const kiro = await json('adapters/kiro/profile.json');
  assert.equal(kiro.enabled, false);
  assert.deepEqual(kiro.events, []);
  return { valid: true, profile: 'graphlin-local-manifests', hostActivationVerified: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
    await publicPackageFiles(root);
    const result = await validatePackage(root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write('Graphlin package validation failed.\n'); process.exitCode = 1; }
}
