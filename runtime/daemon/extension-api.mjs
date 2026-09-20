import {
  createFrameDocument, getExtensionDataProjection, validateGrant, extensionId,
  id, digest, integer, exact, uniqueStrings, jsonBytes, EXTENSION_LIMITS,
} from '../extensions/index.mjs';
import { safeText } from '../core/privacy.mjs';

const PREFIX = '/api/extensions';
const HTTP_ERROR = Symbol('extension_http_error');
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code, [HTTP_ERROR]: true }); };
const sameGrant = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function reply(res, status, value) {
  const body = jsonBytes(value, EXTENSION_LIMITS.projectionBytes);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
async function bodyJSON(req) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail(415, 'invalid_content_type');
  if (req.headers['content-encoding']) fail(400, 'unsupported_content_encoding');
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), 2000);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024) fail(413, 'extension_request_limit');
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail(400, 'invalid_json'); }
    return value;
  } finally { clearTimeout(timer); }
}
function parameters(query, allowed) {
  const result = {};
  for (const [name, value] of new URLSearchParams(query)) {
    if (!allowed.includes(name) || Object.hasOwn(result, name) || !value) fail(400, 'invalid_extension_query');
    result[name] = value;
  }
  for (const field of ['scope', 'session', 'checkpoint']) {
    if (result[field] !== undefined && !id(result[field])) fail(400, 'invalid_extension_query');
  }
  if (result.nonce !== undefined && !/^[A-Za-z0-9_-]{24,128}$/.test(result.nonce)) fail(400, 'invalid_frame_nonce');
  return result;
}

/**
 * Parent performs loopback/Host/Origin checks and viewer-cookie authentication.
 * Never pass viewerAuthorized for an external read bearer or an opaque origin.
 * getSnapshot is synchronous and reapplies current core policy, like model-api.
 */
export function createExtensionAPI({ registry, getSnapshot, projectId, runAnalysis } = {}) {
  if (!registry || typeof getSnapshot !== 'function' || !id(projectId) ||
    (runAnalysis !== undefined && typeof runAnalysis !== 'function')) throw new TypeError('invalid_extension_api_options');

  async function requireGrant(extension, expectedDigest) {
    const value = await registry.getGrant(extension);
    try { validateGrant(value); } catch { fail(403, 'extension_grant_denied'); }
    if (!value.approved || value.projectId !== projectId || value.extensionId !== extension) fail(403, 'extension_grant_denied');
    if (expectedDigest !== undefined && value.digest !== expectedDigest) fail(409, 'extension_digest_changed');
    return value;
  }
  function snapshot(params, grant) {
    // A session selector can address historical work even without a checkpoint.
    if ((params.checkpoint || params.session) && !grant.history) fail(403, 'history_not_granted');
    const raw = getSnapshot({
      ...(params.scope ? { scopeId: params.scope } : {}),
      ...(params.session ? { sessionId: params.session } : {}),
      ...(params.checkpoint ? { checkpointId: params.checkpoint } : {}),
      persistent: false,
    });
    if (!raw || typeof raw !== 'object' || raw.then || raw.projectId !== projectId) fail(503, 'invalid_model_snapshot');
    const projected = getExtensionDataProjection(
      params.checkpoint ? { ...raw, checkpointId: params.checkpoint, replay: true } : raw, grant);
    if (!projected) fail(403, 'extension_grant_denied');
    return projected;
  }
  async function unchanged(extension, prior) {
    const current = await requireGrant(extension, prior.digest);
    if (!sameGrant(prior, current)) fail(403, 'extension_grant_changed');
    return current;
  }
  async function analyze(req, res) {
    const input = await bodyJSON(req);
    if (!exact(input, ['id', 'digest', 'profileId', 'entityIds', 'revision']) ||
      !extensionId(input.id) || !digest(input.digest) || !id(input.profileId) ||
      !uniqueStrings(input.entityIds, id, 256) || !input.entityIds.length || !integer(input.revision)) {
      fail(400, 'invalid_analysis_request');
    }
    const grant = await requireGrant(input.id, input.digest);
    if (!grant.profiles?.includes(input.profileId)) fail(403, 'analysis_profile_not_granted');
    const installed = await registry.getAssets(input.id, { digest: input.digest });
    if (!installed.manifest.capabilities.includes('analysis.request')) fail(403, 'analysis_not_granted');
    const profile = installed.profiles.find(value => value.id === input.profileId);
    if (!profile) fail(403, 'analysis_profile_not_granted');
    if (profile.selectors.fields.some(field => !grant.fields.includes(field))) fail(403, 'analysis_field_not_granted');
    await unchanged(input.id, grant);
    const model = snapshot({}, grant);
    if (model.revision !== input.revision) fail(409, 'analysis_revision_changed');
    if (!input.entityIds.every(entityId => model.entities.some(value => value.id === entityId)) ||
      (profile.selectors.candidateIds.length &&
        !input.entityIds.every(entityId => profile.selectors.candidateIds.includes(entityId)))) fail(403, 'analysis_candidate_not_granted');
    if (!runAnalysis) fail(501, 'extension_analysis_unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      // Core owns provider calls, source consent/filtering, approval capabilities,
      // evidence-version checks, subscriptions, and recording interpretations.
      const result = await runAnalysis({
        projectId, extensionId: input.id, digest: input.digest, profile,
        entityIds: [...input.entityIds], revision: input.revision, grant, signal: controller.signal,
      });
      await unchanged(input.id, grant);
      const current = snapshot({}, grant);
      if (!result || !['accepted', 'pending', 'complete', 'unavailable'].includes(result.status)) fail(503, 'invalid_analysis_result');
      const interpretationIds = Array.isArray(result.interpretationIds) ? result.interpretationIds.slice(0, 256)
        .filter(value => id(value) && current.interpretations.some(item =>
          item.id === value && item.namespace === profile.namespace)) : [];
      if (!res.destroyed) reply(res, result.status === 'pending' || result.status === 'accepted' ? 202 : 200, {
        status: result.status,
        ...(id(result.requestId) && safeText(result.requestId, 160) ? { requestId: result.requestId } : {}),
        interpretationIds: [...new Set(interpretationIds)],
      });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  }
  async function handle(req, res, { viewerAuthorized = false } = {}) {
    if (typeof req.url !== 'string' ||
      !(req.url === PREFIX || req.url.startsWith(`${PREFIX}/`) || req.url.startsWith(`${PREFIX}?`))) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (viewerAuthorized !== true || req.headers.origin === 'null') fail(401, 'viewer_authorization_required');
      if (req.url.length > 4096 || /[\s\\#]/.test(req.url) || /%(?![a-f\d]{2})/i.test(req.url)) fail(400, 'invalid_extension_route');
      const [pathname, query = '', ...extra] = req.url.split('?');
      if (extra.length || pathname.includes('%') || pathname.includes('//') ||
        pathname.split('/').some(part => part === '.' || part === '..')) fail(400, 'invalid_extension_route');
      const route = pathname.slice(PREFIX.length);
      const read = /^\/(data|frame)\/([^/]+)$/.exec(route);
      if (read && !extensionId(read[2])) fail(400, 'invalid_extension_id');
      const params = parameters(query, read?.[1] === 'data' ? ['scope', 'session', 'checkpoint'] :
        read?.[1] === 'frame' ? ['nonce'] : []);
      if (req.method === 'GET') {
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) fail(400, 'unexpected_body');
        if (route === '') { reply(res, 200, await registry.list()); return true; }
        if (!read) fail(404, 'extension_route_not_found');
        const extension = read[2];
        const grant = await requireGrant(extension);
        if (read[1] === 'data') {
          reply(res, 200, snapshot(params, grant));
        } else {
          if (!params.nonce) fail(400, 'invalid_frame_nonce');
          const assets = await registry.getAssets(extension, { digest: grant.digest });
          await unchanged(extension, grant);
          const frame = createFrameDocument({ ...assets, nonce: params.nonce });
          // DENY remains on every other route. Response CSP sandboxing and
          // frame-ancestors 'self' protect the directly opened frame document.
          res.removeHeader('X-Frame-Options');
          for (const [name, value] of Object.entries(frame.headers)) res.setHeader(name, value);
          res.writeHead(200); res.end(frame.body);
        }
        return true;
      }
      if (req.method !== 'POST') fail(405, 'extension_method_not_allowed');
      if (route === '/analysis') { await analyze(req, res); return true; }
      if (!['/grant', '/revoke'].includes(route)) fail(404, 'extension_route_not_found');
      const input = await bodyJSON(req);
      if (route === '/grant') {
        if (!exact(input, ['id', 'digest', 'fields', 'history', 'approved'], ['profiles']) ||
          !extensionId(input.id)) fail(400, 'invalid_extension_grant');
        const { id: extension, ...request } = input;
        reply(res, 200, await registry.grant(extension, request));
      } else {
        if (!exact(input, ['id']) || !extensionId(input.id)) fail(400, 'invalid_extension_revoke');
        reply(res, 200, await registry.revoke(input.id));
      }
    } catch (error) {
      const known = {
        extension_not_installed: [404, 'extension_not_installed'],
        extension_digest_changed: [409, 'extension_digest_changed'],
        unrequested_data_field: [403, 'unrequested_data_field'],
        unrequested_profile: [403, 'unrequested_profile'],
        unrequested_history: [403, 'unrequested_history'],
        unrequested_analysis: [403, 'unrequested_analysis'],
        invalid_extension_grant: [400, 'invalid_extension_grant'],
        MODEL_CHECKPOINT_UNAVAILABLE: [404, 'checkpoint_unavailable'],
        MODEL_SCOPE_UNAVAILABLE: [404, 'scope_unavailable'],
      }[error?.code];
      const status = error?.[HTTP_ERROR] ? error.status : known?.[0] ?? 503;
      const code = error?.[HTTP_ERROR] ? error.code : known?.[1] ?? 'extension_unavailable';
      if (!res.headersSent && !res.destroyed) reply(res, status, { error: code });
      else if (!res.destroyed) res.destroy();
    }
    return true;
  }
  return { handle };
}
