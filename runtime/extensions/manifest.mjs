import { createHash } from 'node:crypto';
import {
  API_VERSION, MODEL_SCHEMA, SCENE_VERSION, MANIFEST_FILE, FEATURES, CAPABILITIES,
  EXTENSION_LIMITS as L, check, plain, exact, extensionId, version, text,
  uniqueStrings, assetPath, jsonBytes,
} from './contracts.mjs';
import { validateDecisionProfile } from './profiles.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateManifest(input) {
  jsonBytes(input, L.manifestBytes, 'manifest_too_large');
  check(exact(input, ['manifestVersion', 'graphlinApi', 'modelSchema', 'id', 'version',
    'requiredFeatures', 'entry', 'assets', 'views', 'renderer', 'capabilities'], ['name', 'decisionProfiles']), 'invalid_manifest');
  check(input.manifestVersion === 1 && input.graphlinApi === String(API_VERSION) &&
    input.modelSchema === String(MODEL_SCHEMA), 'incompatible_extension');
  check(extensionId(input.id) && version(input.version) &&
    (input.name === undefined || text(input.name, 80)), 'invalid_manifest');
  check(uniqueStrings(input.requiredFeatures, value => FEATURES.includes(value)), 'unknown_required_feature');
  check(uniqueStrings(input.capabilities, value => CAPABILITIES.includes(value)), 'unknown_capability');
  check(uniqueStrings(input.views, value => /^[a-z][a-z0-9-]{0,39}$/.test(value), 16) &&
    input.views.length > 0, 'invalid_views');
  const renderer = input.renderer;
  check((exact(renderer, ['kind', 'sceneVersion']) && renderer.kind === 'graphlin-scene' &&
      renderer.sceneVersion === String(SCENE_VERSION)) ||
    (exact(renderer, ['kind']) && renderer.kind === 'custom'), 'unsupported_renderer');
  check(plain(input.assets) && Object.keys(input.assets).length > 0 &&
    Object.keys(input.assets).length <= L.assets, 'invalid_assets');
  for (const [name, hash] of Object.entries(input.assets)) {
    check(assetPath(name) && name !== MANIFEST_FILE && /\.(?:js|json)$/.test(name) &&
      typeof hash === 'string' && /^sha256-[a-f0-9]{64}$/.test(hash), 'invalid_asset');
  }
  const names = Object.keys(input.assets);
  check(new Set(names.map(name => name.toLowerCase())).size === names.length, 'duplicate_asset');
  check(assetPath(input.entry) && input.entry.endsWith('.js') &&
    Object.hasOwn(input.assets, input.entry), 'invalid_entry');
  // The single executable bundle contains its dependencies. Other declared
  // assets are inert JSON supplied by the frame prelude; no runtime imports.
  check(names.filter(name => name.endsWith('.js')).length === 1, 'unbundled_scripts');
  if (input.decisionProfiles !== undefined) {
    check(uniqueStrings(input.decisionProfiles, name => assetPath(name) && name.endsWith('.json') &&
      Object.hasOwn(input.assets, name), 8), 'invalid_decision_profiles');
    check(!input.decisionProfiles.length || input.capabilities.includes('analysis.request'), 'missing_analysis_capability');
  }
  return JSON.parse(JSON.stringify(input));
}

export function validateAssets(manifestInput, input) {
  const manifest = validateManifest(manifestInput);
  check(plain(input) && Object.keys(input).length === Object.keys(manifest.assets).length, 'asset_set_mismatch');
  let total = 0;
  const assets = {};
  for (const [name, hash] of Object.entries(manifest.assets)) {
    check(Object.hasOwn(input, name) && (typeof input[name] === 'string' || input[name] instanceof Uint8Array),
      'missing_asset');
    const bytes = Buffer.from(input[name]);
    total += bytes.length;
    check(bytes.length <= L.assetBytes && total <= L.packageBytes, 'asset_too_large');
    check(`sha256-${sha256(bytes)}` === hash, 'asset_integrity_mismatch');
    // Reject non-UTF8 bytes rather than silently changing executable content.
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { check(false, 'asset_encoding'); }
    if (name.endsWith('.json')) {
      try { JSON.parse(source); } catch { check(false, 'invalid_json_asset'); }
    } else {
      // This is packaging validation, not a JavaScript security sandbox. CSP
      // remains authoritative if a bundle constructs a URL dynamically.
      check(!/\bimport\s*(?:[('"*{]|[A-Za-z_$].*\bfrom\b)|\bexport\s|\/\/[#@]\s*sourceMappingURL\s*=/.test(source),
        'unbundled_scripts');
    }
    assets[name] = bytes;
  }
  return assets;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function bundleDigest(manifest) {
  return sha256(JSON.stringify(canonical(validateManifest(manifest))));
}

export function decisionProfiles(manifest, assets) {
  const seen = new Set();
  return (manifest.decisionProfiles ?? []).map(name => {
    const profile = validateDecisionProfile(JSON.parse(Buffer.from(assets[name]).toString('utf8')));
    check(!seen.has(profile.id), 'duplicate_decision_profile');
    seen.add(profile.id);
    return { ...profile, namespace: `${manifest.id}.${profile.id}` };
  });
}
