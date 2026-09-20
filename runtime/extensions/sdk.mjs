// This entry has no Node imports. Bundle it with the extension's one classic
// browser entry, or use the graphlin:connect event directly without a build tool.
export { API_VERSION, MODEL_SCHEMA, SCENE_VERSION, EXTENSION_LIMITS } from './contracts.mjs';
export { validateScene, SCENE_KINDS, SCENE_SHAPES, EDGE_KINDS } from './scene.mjs';
export { validateDecisionProfile } from './profiles.mjs';
import { check, exact, id, integer, jsonBytes, EXTENSION_LIMITS } from './contracts.mjs';
import { validateScene } from './scene.mjs';

const CONTEXT = ['instanceId', 'projectId', 'revision', 'viewEpoch', 'requestId'];
export function validateMessage(message, { model, context } = {}) {
  const payloadFields = {
    'graphlin:project': ['model', 'settings', 'selection'], 'graphlin:scene': ['scene'],
    'graphlin:dispose': [], 'graphlin:error': ['code'], 'graphlin:status': ['status', 'itemCount'],
    'graphlin:select': ['selection'],
  };
  check(message && Object.hasOwn(payloadFields, message.type) &&
    exact(message, ['type', 'apiVersion', ...CONTEXT], payloadFields[message.type]) &&
    message.apiVersion === 1 && ['instanceId', 'projectId', 'requestId'].every(key => id(message[key])) &&
    integer(message.revision) && integer(message.viewEpoch), 'invalid_extension_message');
  jsonBytes(message, EXTENSION_LIMITS.projectionBytes, 'extension_message_limit');
  if (context) check(['apiVersion', ...CONTEXT].every(key => message[key] === context[key]),
    'extension_message_context_mismatch');
  if (model) check(model.schemaVersion === 2 && model.projectId === message.projectId &&
    model.revision === message.revision, 'extension_model_context_mismatch');
  if (message.type === 'graphlin:status') {
    check(['ready', 'busy', 'empty', 'error'].includes(message.status) &&
      integer(message.itemCount, EXTENSION_LIMITS.entities), 'invalid_extension_status');
  }
  if (message.type === 'graphlin:error') {
    check(['extension_projection_failed', 'extension_unavailable', 'extension_cancelled'].includes(message.code),
      'invalid_extension_error');
  }
  if (message.type === 'graphlin:select') {
    check(exact(message.selection, [], ['entityId', 'relationId', 'activityId']) &&
      Object.keys(message.selection).length === 1 && Object.values(message.selection).every(id), 'invalid_extension_selection');
    check(model, 'selection_projection_required');
    const [field, target] = Object.entries(message.selection)[0];
    const collection = { entityId: 'entities', relationId: 'relations', activityId: 'activity' }[field];
    check(Array.isArray(model[collection]) && model[collection].some(value => value.id === target),
      'unknown_extension_selection');
  }
  return message;
}

/** Minimal asynchronous lifecycle. The host also enforces deadlines, rate and
 * size limits, context matching, current grants, and disposal on navigation.
 */
export function connectExtension({ project, mount, dispose } = {}) {
  check(project === undefined || typeof project === 'function', 'invalid_extension_projector');
  check(mount === undefined || typeof mount === 'function', 'invalid_extension_mount');
  let port, stopped = false, epoch = -1, request = 0;
  const stop = () => {
    if (stopped) return;
    stopped = true; request++;
    port?.close();
    window.removeEventListener('graphlin:connect', connected);
    dispose?.();
  };
  function connected(event) {
    if (port || stopped) return;
    port = event.detail.port;
    mount?.({ root: document.getElementById('graphlin-extension'), assets: event.detail.assets });
    port.onmessage = async event => {
      let message;
      try { message = validateMessage(event.data); } catch { return; }
      if (message.type === 'graphlin:dispose') { stop(); return; }
      if (message.type !== 'graphlin:project' || message.viewEpoch < epoch || stopped) return;
      epoch = message.viewEpoch;
      const current = ++request;
      const context = Object.fromEntries(CONTEXT.map(key => [key, message[key]]));
      try {
        check(message.model?.schemaVersion === 2 && message.model.projectId === message.projectId &&
          message.model.revision === message.revision, 'extension_model_context_mismatch');
        const output = await project?.(message.model, message.settings ?? {}, message.selection ?? null);
        if (current !== request || stopped || !output) return;
        const scene = validateScene(output, { model: message.model });
        port.postMessage({ type: 'graphlin:scene', apiVersion: 1, ...context, scene });
      } catch {
        if (current === request && !stopped) port.postMessage({
          type: 'graphlin:error', apiVersion: 1, ...context, code: 'extension_projection_failed',
        });
      }
    };
    port.start();
  }
  window.addEventListener('graphlin:connect', connected);
  return stop;
}
