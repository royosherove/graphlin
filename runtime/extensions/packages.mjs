import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import {
  MANIFEST_FILE, EXTENSION_LIMITS as L, check, extensionError, assetPath, version,
} from './contracts.mjs';
import { validateManifest, validateAssets, bundleDigest, decisionProfiles } from './manifest.mjs';

export function checkCancelled(signal) {
  if (signal?.aborted) throw extensionError('extension_cancelled');
}

// Walk every component, including ancestors: O_NOFOLLOW only protects a leaf.
export async function safeDirectory(directory, { owned = false } = {}) {
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_extension_directory');
  }
  const stat = await lstat(resolved);
  if (owned) check((stat.mode & 0o077) === 0 &&
    (process.getuid?.() === undefined || stat.uid === process.getuid()), 'unsafe_extension_directory');
  return resolved;
}

export async function readRegular(filename, maxBytes = L.assetBytes, { privateFile = false } = {}) {
  await safeDirectory(path.dirname(filename));
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    check(stat.isFile() && stat.nlink === 1 && stat.size <= maxBytes, 'unsafe_extension_file');
    if (privateFile) check((stat.mode & 0o077) === 0 &&
      (process.getuid?.() === undefined || stat.uid === process.getuid()), 'unsafe_extension_file');
    // A bounded read also covers a file growing after stat().
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    check(offset === stat.size, 'extension_file_changed');
    return bytes.subarray(0, offset);
  } finally { await handle?.close(); }
}

export function parsePackageSpec(spec) {
  check(typeof spec === 'string' && spec.length <= 240, 'invalid_package_spec');
  const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/.exec(spec);
  check(match && version(match[2]), 'exact_package_version_required');
  return { name: match[1], version: match[2] };
}

function json(bytes, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw extensionError(code); }
}

function validateFiles(files, packageSpec) {
  check(files.has(MANIFEST_FILE), 'manifest_missing');
  const manifestBytes = files.get(MANIFEST_FILE);
  check(manifestBytes.length <= L.manifestBytes, 'manifest_too_large');
  const manifest = validateManifest(json(manifestBytes, 'invalid_manifest'));
  const allowed = new Set([MANIFEST_FILE, 'package.json', 'README.md', 'LICENSE', ...Object.keys(manifest.assets)]);
  check([...files.keys()].every(name => allowed.has(name)), 'undeclared_package_file');
  if (files.has('package.json')) {
    const pkg = json(files.get('package.json'), 'invalid_package_metadata');
    check(pkg && typeof pkg === 'object' && !Array.isArray(pkg) && pkg.version === manifest.version,
      'package_version_mismatch');
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
      check(pkg[field] === undefined || (pkg[field] && typeof pkg[field] === 'object' &&
        Object.keys(pkg[field]).length === 0), 'runtime_dependencies_not_supported');
    }
    if (packageSpec) check(pkg.name === packageSpec.name && pkg.version === packageSpec.version, 'package_identity_mismatch');
  } else check(!packageSpec, 'package_metadata_missing');
  const assetInputs = Object.fromEntries(Object.keys(manifest.assets).filter(name => files.has(name))
    .map(name => [name, files.get(name)]));
  const assets = validateAssets(manifest, assetInputs);
  const profiles = decisionProfiles(manifest, assets);
  return { manifest, assets, profiles, digest: bundleDigest(manifest) };
}

export async function readLocalPackage(directory, { signal } = {}) {
  const root = await safeDirectory(directory);
  const files = new Map();
  let count = 0, total = 0;
  // Parse the manifest first; only the explicit package allowlist may be read.
  files.set(MANIFEST_FILE, await readRegular(path.join(root, MANIFEST_FILE), L.manifestBytes));
  const manifest = validateManifest(json(files.get(MANIFEST_FILE), 'invalid_manifest'));
  const allowed = new Set([MANIFEST_FILE, 'package.json', 'README.md', 'LICENSE', ...Object.keys(manifest.assets)]);
  async function inspect(relative = '') {
    checkCancelled(signal);
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      check(++count <= L.files, 'package_file_limit');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      check(assetPath(name), 'unsafe_package_path');
      const stat = await lstat(path.join(root, name));
      check(!stat.isSymbolicLink(), 'unsafe_package_link');
      if (stat.isDirectory()) {
        check([...allowed].some(value => value.startsWith(`${name}/`)), 'undeclared_package_file');
        await inspect(name);
      } else {
        check(stat.isFile() && allowed.has(name), 'undeclared_package_file');
        if (name !== MANIFEST_FILE) files.set(name, await readRegular(path.join(root, name)));
        total += files.get(name).length;
        check(total <= L.packageBytes, 'package_too_large');
      }
    }
  }
  await inspect();
  return validateFiles(files);
}

function tarString(block, start, size) {
  const field = block.subarray(start, start + size);
  const end = field.indexOf(0);
  if (end >= 0) check(field.subarray(end).every(byte => byte === 0), 'invalid_archive_header');
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}
function octal(block, start, size) {
  const value = block.subarray(start, start + size).toString('ascii').replace(/\0.*$/, '').trim();
  check(/^[0-7]+$/.test(value), 'invalid_archive_number');
  const result = Number.parseInt(value, 8);
  check(Number.isSafeInteger(result), 'invalid_archive_number');
  return result;
}

/** Validate before extraction. No system tar, filesystem writes, links, PAX,
 * sparse files, device nodes, or archive-controlled permissions are used. */
export function readPackageArchive(input, spec) {
  check(input instanceof Uint8Array && input.length <= L.archiveBytes, 'archive_too_large');
  let bytes = Buffer.from(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { bytes = gunzipSync(bytes, { maxOutputLength: L.archiveBytes }); }
    catch { throw extensionError('invalid_or_oversized_archive'); }
  }
  check(bytes.length <= L.archiveBytes && bytes.length % 512 === 0, 'invalid_archive');
  const files = new Map(), names = new Set();
  let offset = 0, total = 0, count = 0, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      check(bytes.length - offset >= 1024 && bytes.subarray(offset).every(byte => byte === 0), 'invalid_archive_end');
      ended = true; break;
    }
    check(++count <= L.files, 'package_file_limit');
    const sum = header.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
    check(sum === octal(header, 148, 8), 'archive_checksum_mismatch');
    const type = header[156];
    check([0, 48, 53].includes(type), 'unsafe_archive_entry');
    check(!tarString(header, 157, 100), 'unsafe_archive_link');
    const prefix = tarString(header, 345, 155);
    const raw = `${prefix ? `${prefix}/` : ''}${tarString(header, 0, 100)}`;
    const name = type === 53 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    check(name === 'package' || (name.startsWith('package/') && assetPath(name.slice(8))), 'unsafe_archive_path');
    check(!names.has(name.toLowerCase()), 'duplicate_archive_path');
    names.add(name.toLowerCase());
    const size = octal(header, 124, 12);
    check(size <= L.assetBytes && (type !== 53 || size === 0), 'archive_file_limit');
    offset += 512;
    check(offset + Math.ceil(size / 512) * 512 <= bytes.length, 'truncated_archive');
    if (type !== 53) {
      check(name !== 'package', 'unsafe_archive_path');
      total += size;
      check(total <= L.packageBytes, 'package_too_large');
      files.set(name.slice(8), bytes.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  check(ended, 'invalid_archive_end');
  for (const name of files.keys()) {
    check(![...files.keys()].some(other => other.startsWith(`${name}/`)), 'archive_path_conflict');
  }
  return validateFiles(files, parsePackageSpec(spec));
}

/** The only network transport. Tests inject a transport and never call npm. */
export async function npmPackTransport(spec, { directory, signal } = {}) {
  parsePackageSpec(spec);
  checkCancelled(signal);
  const args = ['pack', '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org/',
    '--pack-destination', directory, '--', spec];
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: directory, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, npm_config_ignore_scripts: 'true', npm_config_userconfig: path.join(directory, 'user.npmrc'),
        npm_config_globalconfig: path.join(directory, 'global.npmrc'), npm_config_cache: path.join(directory, 'npm-cache'),
        npm_config_audit: 'false', npm_config_fund: 'false' } });
    let output = '', reason, escalation;
    const stop = code => {
      if (reason) return;
      reason = extensionError(code);
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 300);
    };
    const abort = () => stop('extension_cancelled');
    const timer = setTimeout(() => stop('npm_pack_timeout'), 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', bytes => {
      if (output.length + bytes.length > 64 * 1024) stop('npm_output_limit');
      else output += bytes.toString('utf8');
    });
    const finish = error => {
      clearTimeout(timer); clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(output);
    };
    child.once('error', () => finish(extensionError('npm_unavailable')));
    child.once('close', code => finish(reason || (code ? extensionError('npm_pack_failed') : undefined)));
  });
  let result;
  try { result = JSON.parse(stdout); } catch { throw extensionError('invalid_npm_response'); }
  check(Array.isArray(result) && result.length === 1 && typeof result[0].filename === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\.tgz$/.test(result[0].filename), 'invalid_npm_response');
  return readRegular(path.join(directory, result[0].filename), L.archiveBytes);
}
