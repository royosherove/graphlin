import { createHash } from 'node:crypto';
import { check } from './contracts.mjs';
import { validateManifest, validateAssets } from './manifest.mjs';

const scriptHash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
const scriptJSON = value => JSON.stringify(value).replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

/** Creates a response body AND mandatory response headers. Never serve body
 * alone or as srcdoc: response sandboxing must survive opening the URL directly.
 */
export function createFrameDocument({ manifest: input, assets: inputAssets, nonce } = {}) {
  const manifest = validateManifest(input);
  const assets = validateAssets(manifest, inputAssets);
  check(typeof nonce === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(nonce), 'invalid_frame_nonce');
  const source = assets[manifest.entry].toString('utf8');
  const data = Object.fromEntries(Object.entries(assets).filter(([name]) => name.endsWith('.json'))
    .map(([name, bytes]) => [name, JSON.parse(bytes.toString('utf8'))]));
  // The trusted prelude is installed before third-party code executes. Source is
  // embedded as escaped JSON, not HTML. Appending a script preserves exact bytes
  // for CSP hashing even if an author has a literal closing script tag.
  const prelude = `(() => {
  "use strict";
  const expected = ${scriptJSON(nonce)};
  const parentWindow = window.parent;
  const dispatch = window.dispatchEvent.bind(window);
  const Event = window.CustomEvent;
  let used = false;
  const receive = event => {
    if (used || parentWindow === window || event.source !== parentWindow) return;
    const message = event.data;
    if (!message || message.type !== "graphlin:bootstrap" || message.apiVersion !== 1 ||
        message.nonce !== expected || event.ports.length !== 1) return;
    used = true;
    window.removeEventListener("message", receive);
    const port = event.ports[0];
    const send = port.postMessage.bind(port);
    port.start();
    dispatch(new Event("graphlin:connect", {detail: {port, nonce: expected, apiVersion: 1,
      assets: ${scriptJSON(data)}}}));
    send({type: "graphlin:ready", apiVersion: 1, nonce: expected});
  };
  window.addEventListener("message", receive);
  const script = document.createElement("script");
  script.textContent = ${scriptJSON(source)};
  document.body.appendChild(script);
})();`;
  const csp = [
    "default-src 'none'", `script-src ${scriptHash(prelude)} ${scriptHash(source)}`,
    "script-src-attr 'none'", "connect-src 'none'", "img-src 'none'", "style-src 'none'",
    "font-src 'none'", "media-src 'none'", "object-src 'none'", "frame-src 'none'",
    "worker-src 'none'", "child-src 'none'", "base-uri 'none'", "form-action 'none'",
    "frame-ancestors 'self'", 'sandbox allow-scripts',
  ].join('; ');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Graphlin extension</title></head><body><main id="graphlin-extension"></main><script>${prelude}</script></body></html>`;
  return { body, csp, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
  } };
}
