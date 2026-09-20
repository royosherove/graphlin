import { validateScene } from '../extensions/scene.mjs';
import { jsonBytes, id, integer, EXTENSION_LIMITS } from '../extensions/contracts.mjs';
import { validateMessage } from '../extensions/sdk.mjs';

const CONTEXT = ['instanceId', 'projectId', 'revision', 'viewEpoch', 'requestId'];
const nonceValue = () => {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
};

/** Only the host's projected-data route supplies `model`. A frame never receives
 * fetch, cookies, a daemon token, or the host's unprojected snapshot.
 */
export function createExtensionFrame({
  root, extension, onSelect = () => {}, onFailure = () => {},
  Channel = globalThis.MessageChannel, nonce = nonceValue(), timeout = 5000,
}) {
  const frame = root.ownerDocument.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', extension.manifest.name || extension.id);
  frame.setAttribute('src', `/api/extensions/frame/${encodeURIComponent(extension.id)}?nonce=${encodeURIComponent(nonce)}`);
  const channel = new Channel(), port = channel.port1;
  let stopped = false, loaded = false, ready = false, requestNumber = 0, pending, latest;
  const granted = model => extension.grant?.approved === true &&
    extension.grant.projectId === model?.projectId && extension.grant.extensionId === extension.id &&
    extension.grant.digest === extension.digest;
  let readyResolve, readyReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A frame can fail before update attaches its await handler.
  readyPromise.catch(() => {});
  const readyTimer = setTimeout(() => fail(new Error('extension_ready_timeout')), timeout);
  function rejectPending(error) {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
  }
  function stop(error = new Error('extension_disposed')) {
    if (stopped) return;
    stopped = true;
    clearTimeout(readyTimer);
    readyReject(error); rejectPending(error);
    port.onmessage = null; port.close(); channel.port2.close();
    frame.removeEventListener('load', onLoad); frame.remove();
    latest = null;
  }
  function fail(error) { stop(error); onFailure(); }
  function onLoad() {
    console.warn('Fixture frame loaded');
    if (stopped) return;
    if (loaded) { fail(new Error('extension_navigated')); return; }
    loaded = true;
    // Opaque-origin sandbox recipients require "*"; the exact frame WindowProxy,
    // a fresh nonce, and the one-use port bind this bootstrap to its document.
    frame.contentWindow.postMessage({ type: 'graphlin:bootstrap', apiVersion: 1, nonce }, '*', [channel.port2]);
  }
  let windowStart = Date.now(), messages = 0;
  port.onmessage = event => {
    if (stopped) return;
    try {
      if (Date.now() - windowStart > 1000) { windowStart = Date.now(); messages = 0; }
      if (++messages > 120) throw new Error('extension_message_rate');
      const message = event.data;
      console.warn('Fixture frame message:', message?.type);
      jsonBytes(message, EXTENSION_LIMITS.projectionBytes, 'extension_message_limit');
      if (!ready) {
        if (!loaded || message?.type !== 'graphlin:ready' || message.apiVersion !== 1 || message.nonce !== nonce)
          throw new Error('invalid_extension_ready');
        ready = true; clearTimeout(readyTimer); readyResolve(); return;
      }
      if (!message || message.apiVersion !== 1 || !latest ||
        !CONTEXT.every(key => message[key] === latest.context[key])) return;
      validateMessage(message, { model: latest.model, context: { apiVersion: 1, ...latest.context } });
      if (message.type === 'graphlin:select') {
        const capabilities = extension.manifest.capabilities || [];
        const field = message.selection?.entityId ? 'entities' : message.selection?.relationId ? 'relations' : 'activity';
        if (!granted(latest.model) || !capabilities.some(value => ['selection.request', 'inspection.request'].includes(value)) ||
          !extension.grant.fields?.includes(field) || (field === 'relations' && !extension.grant.fields.includes('entities'))) return;
        const selection = message.selection;
        if (selection?.entityId && latest.model.entities.some(entity => entity.id === selection.entityId))
          onSelect({ entityId: selection.entityId });
        else if (selection?.relationId && latest.model.relations.some(relation => relation.id === selection.relationId))
          onSelect({ relationId: selection.relationId });
        else if (selection?.activityId && latest.model.activity.some(activity => activity.id === selection.activityId))
          onSelect({ activityId: selection.activityId });
        return;
      }
      if (!pending) return;
      if (message.type === 'graphlin:status' && message.status === 'busy') return;
      if (message.type === 'graphlin:status' && message.status === 'error') {
        rejectPending(new Error('extension_projection_failed')); return;
      }
      let result;
      if (message.type === 'graphlin:scene' && extension.manifest.renderer.kind === 'graphlin-scene')
        result = { kind: 'scene', scene: validateScene(message.scene, { model: latest.model }) };
      else if (message.type === 'graphlin:status' && extension.manifest.renderer.kind === 'custom' &&
        ['ready', 'empty'].includes(message.status) && integer(message.itemCount, 20000))
        result = { kind: 'custom', status: message.status, itemCount: message.itemCount };
      else if (message.type === 'graphlin:error') { rejectPending(new Error('extension_projection_failed')); return; }
      else throw new Error('invalid_extension_response');
      clearTimeout(pending.timer); const resolve = pending.resolve; pending = null; resolve(result);
    } catch (error) { fail(error); }
  };
  port.start();
  frame.addEventListener('load', onLoad);
  root.replaceChildren(frame);
  return {
    async update({ model, settings = {}, selection = null, viewEpoch = 0 }) {
      if (!granted(model)) throw new Error('extension_grant_denied');
      await readyPromise;
      if (stopped) throw new Error('extension_disposed');
      rejectPending(new Error('extension_superseded'));
      const context = {
        instanceId: `frame.${nonce}`, projectId: model.projectId, revision: model.revision,
        viewEpoch, requestId: `request.${++requestNumber}`,
      };
      if (!id(context.projectId) || !integer(context.revision)) throw new Error('invalid_extension_context');
      const message = { type: 'graphlin:project', apiVersion: 1, ...context, model, settings, selection };
      jsonBytes(message, EXTENSION_LIMITS.projectionBytes);
      latest = { context, model };
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => fail(new Error('extension_projection_timeout')), timeout) };
        port.postMessage(message);
      });
    },
    dispose() {
      if (!stopped && ready && latest) port.postMessage({ type: 'graphlin:dispose', apiVersion: 1, ...latest.context });
      stop();
    },
  };
}
