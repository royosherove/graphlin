import { BUILTIN_VIEWS, createBuiltin } from '../visualizers/index.mjs';
import { createModelClient, modelQuery, hydrateModel } from './model-client.js';
import { ancestors } from '../visualizers/structure.mjs';
import { createExtensionFrame } from './extension-frame.js';
import { DATA_FIELDS, extensionId, digest, id as validId } from '../extensions/contracts.mjs';
import { filterScene } from './scene.js';

const DISCOVERY_STATES = ['idle', 'waiting', 'queued', 'running', 'complete', 'partial', 'unavailable'];
const DISCOVERY_BLOCKED = ['source_consent_required', 'missing_key', 'no_source', 'paused', 'unsupported_service', 'endpoint_unavailable'];
const DISCOVERY_REASONS = {
  source_consent_required: 'Architecture discovery needs source-transmission consent. Enable source mode for this project in Graphlin setup.',
  missing_key: 'Configure a classification service key in Graphlin setup to discover architecture.',
  no_source: 'No source evidence is available yet. Let Graphlin inspect project files, then try again.',
  paused: 'Classification is paused. Resume classification to discover architecture.',
  source_withheld: 'Source was withheld by local privacy filtering. Remove hardcoded secrets and secret fallbacks from source; reference environment variables only, then recheck sources.',
  unsupported_source: 'Some source is unsupported for architecture discovery. Use supported source formats, then recheck sources.',
  source_unavailable: 'Some source could not be captured or parsed for architecture discovery. Check that project files are available, then recheck sources.',
  analysis_failed: 'Architecture discovery could not finish. Try again; supported boundaries remain available.',
  unsupported_service: 'The configured classification service does not support architecture discovery.',
  source_changed: 'Source changed during discovery. Boundaries will be checked against current evidence.',
  partial_coverage: 'Some evidence is unavailable. The shown boundaries cover only inspected evidence.',
  none_supported: 'No supported application or component boundaries were found. Source scopes remain available.',
  endpoint_unavailable: 'Architecture discovery requires a newer local service.',
  request_failed: 'Could not check architecture discovery. Reconnect to the local service or try again.',
};
function discoveryStatus(value) {
  if (!value || !DISCOVERY_STATES.includes(value.status)) throw new Error('invalid_architecture_status');
  const result = { status: value.status, reason: typeof value.reason === 'string' && Object.hasOwn(DISCOVERY_REASONS, value.reason) ? value.reason : '' };
  for (const name of ['applications', 'components', 'pending', 'inspected', 'total',
    'attempted', 'analyzed', 'withheld', 'unsupported', 'unavailable']) {
    if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= 1_000_000) result[name] = value[name];
  }
  return result;
}

export function createViewPlatform({ document, request, onView, onSelect, onFollow = () => {}, onActivity = () => {}, onArchitecture,
  architectureEnabled = () => true,
  createFrame = createExtensionFrame, grantPollMs = 2000, architecturePollMs = 2000 }) {
  const $ = id => document.getElementById(id);
  let model, active = 'graphlin.code', instance, installed = [], generation = 0, closed = false;
  let loading = true, loadEpoch = 0, pendingView = 'graphlin.blocks';
  let projectionController;
  let analysisBusy = false;
  let grantWatch;
  let architectureWatch, architectureState, architectureProject, architectureBusy = false, suspended = true;
  let architectureModelReady = false;
  let selection = {}, serverSessionId, canonicalSelection = null, follow = true, query = '', kinds = null, focusEntityId = null;
  const settings = new Map(), listeners = [];
  const ownSettings = () => {
    if (!settings.has(active)) settings.set(active, { expanded: [], collapsed: [], level: 'applications' });
    return settings.get(active);
  };
  const element = (tag, text) => {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const listen = (id, event, handler) => {
    const node = $(id);
    if (node) { node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler)); }
  };
  function status(message = '') {
    $('view-status').textContent = message;
    $('view-status').hidden = !message;
    $('view-retry').hidden = !message;
  }
  function dispose() {
    stopArchitecture();
    if (grantWatch) { clearTimeout(grantWatch.timer); grantWatch.controller?.abort(); grantWatch = null; }
    instance?.dispose(); instance = null;
  }
  const architectureLive = () => !closed && !suspended && !document.hidden && architectureModelReady && model &&
    !selection.checkpoint && architectureEnabled() &&
    (active === 'graphlin.c4' || (typeof onArchitecture === 'function' && BUILTIN_VIEWS.some(view => view.id === active)));
  function reportArchitecture(value) {
    architectureState = value === null ? null : discoveryStatus(value);
    if (typeof onArchitecture === 'function') onArchitecture(architectureState ? { ...architectureState } : null);
  }
  function stopArchitecture() {
    const hadStatus = architectureWatch || architectureState;
    if (architectureWatch) {
      clearTimeout(architectureWatch.timer);
      clearTimeout(architectureWatch.deadline);
      architectureWatch.controller?.abort();
      architectureWatch = null;
    }
    architectureBusy = false;
    if (hadStatus) reportArchitecture(null);
  }
  function renderArchitecture() {
    const shown = active === 'graphlin.c4';
    $('architecture-discover').hidden = !shown;
    $('architecture-status').hidden = !shown;
    const state = architectureState;
    $('architecture-discover').textContent = !selection.checkpoint && state?.reason === 'source_withheld'
      ? 'Recheck sources' : 'Discover architecture';
    $('architecture-discover').disabled = !shown || !architectureLive() || architectureBusy ||
      ['queued', 'running'].includes(state?.status) || DISCOVERY_BLOCKED.includes(state?.reason);
    $('architecture-discover').setAttribute('aria-busy', String(architectureBusy));
    if (!shown) return;
    if (selection.checkpoint) {
      $('architecture-status').textContent = 'Recorded architecture. Return to Live to discover current boundaries.';
      return;
    }
    if (!state) { $('architecture-status').textContent = 'Checking architecture discovery…'; return; }
    const messages = {
      idle: 'Ready to discover application and component boundaries for this project.',
      waiting: 'Waiting for source evidence before architecture discovery can continue.',
      queued: 'Architecture discovery queued.',
      running: 'Discovering architecture…',
      complete: 'Architecture discovery complete.',
      partial: 'Architecture is partly discovered; some boundaries remain unknown.',
      unavailable: 'Architecture discovery is unavailable. Check project source settings and the classification service.',
    };
    const counts = ['applications', 'components'].filter(name => state[name] !== undefined)
      .map(name => `${state[name]} ${name}`);
    if (state.analyzed !== undefined) counts.push(`${state.analyzed} analyzed`);
    const checked = state.attempted ?? state.inspected;
    if (checked !== undefined && state.total !== undefined) counts.push(`${checked} of ${state.total} checked`);
    for (const name of ['withheld', 'unsupported', 'unavailable']) if (state[name] > 0) counts.push(`${state[name]} ${name}`);
    if (state.pending > 0) counts.push(`${state.pending} pending`);
    $('architecture-status').textContent = [
      DISCOVERY_REASONS[state.reason] || messages[state.status], counts.join(' · '),
    ].filter(Boolean).join(' ');
  }
  async function refreshArchitecture(watch, manual = false) {
    if (architectureWatch !== watch) return;
    if (!architectureLive()) { syncArchitecture(); return; }
    const controller = new AbortController();
    watch.controller = controller;
    const deadline = watch.deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const result = await request(manual ? '/api/architecture/discover' : '/api/architecture',
        { signal: controller.signal, ...(manual ? { method: 'POST', body: '{}' } : {}) });
      if (architectureWatch !== watch || !architectureLive()) return;
      reportArchitecture(manual && !DISCOVERY_STATES.includes(result?.status) ? { status: 'queued' } : result);
    } catch (error) {
      if (architectureWatch !== watch || !architectureLive()) return;
      reportArchitecture({ status: 'unavailable', reason: error.status === 404 ? 'endpoint_unavailable' : 'request_failed' });
    } finally {
      clearTimeout(deadline);
      if (architectureWatch === watch) {
        if (!architectureLive()) syncArchitecture();
        else {
          architectureBusy = false;
          renderArchitecture();
          if (architectureState?.reason !== 'endpoint_unavailable')
            watch.timer = setTimeout(() => refreshArchitecture(watch), architecturePollMs);
        }
      }
    }
  }
  function syncArchitecture() {
    if (!architectureLive()) stopArchitecture();
    else if (!architectureWatch) {
      if (architectureProject !== model.projectId) { architectureState = null; architectureProject = model.projectId; }
      architectureWatch = {};
      void refreshArchitecture(architectureWatch);
    }
    renderArchitecture();
  }
  function watchGrant(row) {
    if (grantWatch?.instance === instance) return;
    const watch = { instance, id: row.id, digest: row.digest, grant: JSON.stringify(row.grant), timer: null };
    grantWatch = watch;
    const check = async () => {
      if (closed || grantWatch !== watch || instance !== watch.instance) return;
      watch.controller = new AbortController();
      try {
        const response = await request('/api/extensions', { signal: watch.controller.signal });
        if (closed || grantWatch !== watch) return;
        const rows = Array.isArray(response) ? response : response.extensions;
        if (!Array.isArray(rows)) throw new Error('invalid_extension_catalogue');
        const current = rows.find(value => value.id === watch.id);
        if (!current || current.digest !== watch.digest || !current.grant?.approved ||
          JSON.stringify(current.grant) !== watch.grant) {
          generation++; dispose(); onView({ clear: true });
          installed = rows; controls();
          if (current) consent(current);
          status('Visualizer access or its installed version changed. Review access before continuing.');
          return;
        }
      } catch {
        if (closed || grantWatch !== watch) return;
        generation++; dispose(); onView({ clear: true });
        status('Visualizer access could not be verified. Retry the view after reconnecting.');
        return;
      }
      if (grantWatch === watch) watch.timer = setTimeout(check, grantPollMs);
    };
    watch.timer = setTimeout(check, grantPollMs);
  }
  function descriptor() { return BUILTIN_VIEWS.find(view => view.id === active) || installed.find(view => view.id === active); }
  const profilesFor = row => Array.isArray(row?.profiles) ? row.profiles.filter(profile => validId(profile?.id)) : [];
  function options(select, values, chosen) {
    const signature = JSON.stringify(values);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...values.map(([id, label]) => { const option = element('option', label); option.value = id; return option; }));
      select.dataset.options = signature;
    }
    select.value = chosen || '';
  }
  function controls() {
    options($('visualizer'), [...BUILTIN_VIEWS.map(view => [view.id, view.name]),
      ...installed.map(view => [view.id, view.manifest.name || view.id])], pendingView || active);
    for (const option of $('visualizer').children) option.disabled = !model && !loading && option.value !== 'graphlin.code';
    $('view-context').hidden = !model;
    $('c4-level-label').hidden = active !== 'graphlin.c4';
    syncArchitecture();
    $('baseline-label').hidden = active !== 'graphlin.changes';
    $('baseline-create').hidden = active !== 'graphlin.changes';
    $('baseline-create').disabled = Boolean(selection.checkpoint);
    const row = descriptor(), profiles = profilesFor(row);
    $('analysis-controls').hidden = !profiles.length;
    options($('analysis-profile'), profiles.map(profile => [profile.id,
      `${profile.id}${row.grant?.profiles?.includes(profile.id) ? '' : ' (approval needed)'}`]),
    ownSettings().profile || profiles[0]?.id);
    $('analysis-run').disabled = analysisBusy || Boolean(selection.checkpoint) ||
      !row?.grant?.approved || !row.grant.profiles?.includes($('analysis-profile').value) || !model?.entities.length;
    $('c4-level').value = ownSettings().level;
    const checkpoints = (model?.checkpoints || []).map(checkpoint => [checkpoint.id, checkpoint.label || `Revision ${checkpoint.revision}`]);
    options($('task-baseline'), [['', 'Choose checkpoint'], ...checkpoints], ownSettings().baseline);
    options($('model-position'), [['', 'Live'], ...checkpoints], selection.checkpoint);
    const byId = new Map((model?.entities || []).map(entity => [entity.id, entity]));
    const path = selection.scope ? [...ancestors(selection.scope, byId).reverse(), selection.scope] : [];
    const crumbs = [['', 'Project'], ...path.map(id => [id, byId.get(id)?.label || 'Scope'])];
    const breadcrumbSignature = JSON.stringify(crumbs);
    if ($('scope-breadcrumbs').dataset.signature === breadcrumbSignature) return;
    const buttons = crumbs.map(([id, label]) => {
      const button = element('button', label); button.setAttribute('type', 'button');
      button.setAttribute('aria-current', id === (selection.scope || '') ? 'location' : 'false');
      button.addEventListener('click', () => scope(id));
      return button;
    });
    $('scope-breadcrumbs').replaceChildren(...buttons);
    $('scope-breadcrumbs').dataset.signature = breadcrumbSignature;
  }
  function consent(row) {
    $('extension-access').hidden = false;
    const key = `${model.projectId}:${row.id}:${row.digest}:${JSON.stringify(row.grant)}`;
    if ($('extension-access').dataset.key === key) return;
    $('extension-access').dataset.key = key;
    $('extension-access-description').textContent = `${row.manifest.name || row.id} can read the selected project data. ` +
      'Approval applies to this installed version. Source text, excerpts, prompts, and transcripts are never provided.';
    const capabilities = row.manifest.capabilities || [];
    const fields = DATA_FIELDS.filter(field => field !== 'checkpoints' &&
      capabilities.includes(field === 'activity' ? 'activity.read' : 'model.read'));
    $('extension-fields').replaceChildren(...fields.map(field => {
      const label = element('label'), checkbox = element('input');
      checkbox.type = 'checkbox'; checkbox.value = field;
      checkbox.checked = row.grant ? row.grant.fields?.includes(field) : ['entities', 'relations', 'coverage', 'activity'].includes(field);
      label.append(checkbox, element('span', field)); return label;
    }));
    $('extension-history').checked = row.grant?.history === true;
    $('extension-history').disabled = !capabilities.includes('history.read');
    const profiles = profilesFor(row);
    $('extension-profiles').replaceChildren(...profiles.map(profile => {
      const label = element('label'), checkbox = element('input');
      checkbox.type = 'checkbox'; checkbox.value = profile.id;
      checkbox.checked = row.grant?.profiles?.includes(profile.id) || false;
      label.append(checkbox, element('span', `Allow ${profile.id} analysis (${(profile.selectors?.fields || []).join(', ') || 'declared fields'})`));
      return label;
    }));
    $('analysis-note').hidden = !profiles.length;
  }
  async function catalogue(signal) {
    try {
      const result = await request('/api/extensions', { signal });
      if (closed) return;
      installed = (Array.isArray(result) ? result : result.extensions || []).filter(row =>
        extensionId(row.id) && digest(row.digest) && row.manifest?.graphlinApi === '1' &&
        row.manifest?.modelSchema === '2' && ['custom', 'graphlin-scene'].includes(row.manifest?.renderer?.kind));
      controls();
    } catch { /* Older daemons still provide the legacy code map. */ }
  }
  async function project(streamed = false, force = false) {
    if (!model || closed) return;
    projectionController?.abort();
    const controller = new AbortController();
    projectionController = controller;
    const mine = ++generation, view = descriptor();
    controls();
    $('extension-access').hidden = true;
    if (!view) { dispose(); onView({ clear: true }); status('This visualizer is no longer installed. Choose another view.'); return; }
    try {
      let inputModel = model;
      const inputSettings = { ...ownSettings(), ...selection, query, kinds: kinds ? [...kinds] : null, follow };
      if (BUILTIN_VIEWS.some(item => item.id === active)) {
        if (!instance) instance = createBuiltin(active, { root: $('custom-view'), select: onSelect });
        let baseline;
        if (active === 'graphlin.changes' && inputSettings.baseline) {
          const baselineSelection = { ...selection, checkpoint: inputSettings.baseline };
          const raw = await request(`/api/model/v1/snapshot${modelQuery(baselineSelection)}`, { signal: controller.signal });
          baseline = await hydrateModel(raw, { request, selection: baselineSelection, signal: controller.signal });
          if (mine !== generation || closed) return;
        }
        const result = await instance.update({ model: inputModel, settings: inputSettings, baseline,
          apiVersion: 1, projectId: model.projectId, revision: model.revision, viewEpoch: mine });
        if (mine !== generation || closed) return;
        if (result.scene) result.scene = filterScene(result.scene, { query, kinds }, inputModel);
        status();
        onView({ ...result, model: inputModel, id: active, name: view.name, streamed, force,
          focusEntityId: streamed ? focusEntityId : null, selection: canonicalSelection });
      } else {
        // Re-read catalogue/grant for every delivery; an old row is never a
        // continuing permission. Clear controlled content before policy refresh.
        onView({ clear: true });
        await catalogue(controller.signal);
        if (mine !== generation || closed) return;
        const current = installed.find(row => row.id === active);
        if (!current || current.digest !== view.digest) { dispose(); status('The installed version changed. Select it again to review access.'); return; }
        if (JSON.stringify(current.grant) !== JSON.stringify(view.grant)) dispose();
        const liveSession = selection.session && selection.session === serverSessionId && !selection.checkpoint;
        if (!current.grant?.approved || current.grant.projectId !== model.projectId ||
          current.grant.digest !== current.digest ||
          (!current.grant.history && (selection.checkpoint || (selection.session && !liveSession)))) {
          dispose(); consent(current); status(); return;
        }
        // A daemon session selector requires history access. For the current
        // host session, narrow only the already-approved live projection.
        const filterLiveSession = liveSession && !current.grant.history;
        const dataSelection = filterLiveSession ? { ...selection, session: undefined } : selection;
        inputModel = await request(`/api/extensions/data/${encodeURIComponent(active)}${modelQuery(dataSelection)}`, { signal: controller.signal });
        if (mine !== generation || closed) return;
        if (filterLiveSession) inputModel = { ...inputModel,
          activity: inputModel.activity.filter(event => event.sessionId === selection.session),
          sessions: inputModel.sessions.filter(session => session.id === selection.session) };
        if (!instance) instance = createFrame({
          root: $('custom-view'), extension: current, onSelect,
          onFailure: () => { dispose(); onView({ clear: true }); status('Visualizer stopped. Retry view to restart it.'); },
        });
        watchGrant(current);
        const requestedSelection = inputModel.entities.some(entity => entity.id === canonicalSelection)
          ? { entityId: canonicalSelection } : null;
        const result = await instance.update({ model: inputModel, settings: inputSettings, selection: requestedSelection, viewEpoch: mine });
        if (mine !== generation || closed) return;
        if (result.scene) result.scene = filterScene(result.scene, { query, kinds }, inputModel);
        status();
        onView({ ...result, model: inputModel, id: active, name: current.manifest.name || active, streamed, force,
          focusEntityId: streamed ? focusEntityId : null, selection: canonicalSelection });
      }
    } catch (error) {
      if (mine !== generation || closed) return;
      if ([401, 403, 404].includes(error.status)) { dispose(); onView({ clear: true }); }
      else if (view.manifest) {
        await choose('graphlin.code');
        status('The visualizer stopped. Code is shown; select the visualizer to retry.');
        return;
      }
      status('Visualizer unavailable. Retry the view or choose Code.');
    }
  }
  const client = createModelClient({ request, onError: status, onSnapshot(value, streamed) {
    focusEntityId = null;
    if (model && streamed && follow && !query && kinds === null && !selection.checkpoint && value.projectId === model.projectId) {
      const known = new Set(model.entities.map(entity => entity.id));
      const arrival = value.entities.filter(entity => !known.has(entity.id)).at(-1)?.id;
      focusEntityId = arrival || null;
    }
    if (model && model.projectId !== value.projectId) {
      dispose(); settings.clear(); canonicalSelection = null;
      selection = { session: selection.session };
      onView({ clear: true });
    }
    const chosen = Boolean(pendingView);
    if (pendingView) { dispose(); active = pendingView; pendingView = null; }
    model = value;
    architectureModelReady = true;
    const activity = onActivity(value, { ...selection });
    if (activity?.follow === false) focusEntityId = null;
    if (follow && !query && kinds === null && !selection.checkpoint && activity?.follow !== false) {
      const byId = new Map(value.entities.map(entity => [entity.id, entity]));
      const reveal = BUILTIN_VIEWS.some(view => view.id === active) ? activity?.revealEntityIds || [] : [];
      const targets = [...reveal, focusEntityId].filter(id => byId.has(id) &&
        (!selection.scope || id === selection.scope || ancestors(id, byId).includes(selection.scope)));
      ownSettings().expanded = [...new Set([...ownSettings().expanded, ...targets.flatMap(id => ancestors(id, byId))])];
    }
    void project(streamed, chosen);
  } });
  async function loadModel() {
    const mine = ++loadEpoch;
    loading = true;
    architectureModelReady = false;
    stopArchitecture();
    onActivity(null, { ...selection });
    controls();
    const available = await client.open(selection);
    if (closed || suspended || mine !== loadEpoch) return;
    loading = false;
    if (!available && !model && pendingView) {
      pendingView = null;
      status('Model views unavailable. The Code map remains available.');
    }
    controls();
  }
  function choose(id) {
    if (!model) {
      if (loading) { pendingView = id; controls(); status('Loading model… Your chosen view will open when it arrives.'); }
      else { $('visualizer').value = 'graphlin.code'; status('Model views require a newer local service. The Code map remains available.'); }
      return;
    }
    if (id === active) return;
    generation++; dispose(); active = id;
    onView({ clear: true });
    return project(false, true);
  }
  function scope(id) {
    selection.scope = id || undefined;
    generation++; dispose();
    void loadModel();
  }
  async function grant(approved) {
    const row = installed.find(value => value.id === active);
    if (!row) return;
    generation++; dispose(); onView({ clear: true });
    const fields = approved ? [...$('extension-fields').children]
      .map(label => label.children[0]).filter(input => input.checked).map(input => input.value) : [];
    const history = approved && $('extension-history').checked;
    const profiles = approved ? [...$('extension-profiles').children].map(label => label.children[0])
      .filter(input => input.checked).map(input => input.value) : [];
    if (history) fields.push('checkpoints');
    try {
      await request('/api/extensions/grant', { method: 'POST',
        body: JSON.stringify({ id: row.id, digest: row.digest, fields, history, approved, profiles }) });
      await catalogue();
      if (approved) await project(false, true);
      else { $('extension-access').hidden = true; status('Access denied. Choose another view.'); }
    } catch { status('Access could not be updated. Retry after reconnecting.'); }
  }
  listen('visualizer', 'change', () => choose($('visualizer').value));
  listen('view-retry', 'click', () => { dispose(); void loadModel(); });
  listen('c4-level', 'change', () => { ownSettings().level = $('c4-level').value; void project(false, true); });
  listen('architecture-discover', 'click', () => {
    if (active !== 'graphlin.c4' || !architectureLive() || $('architecture-discover').disabled) return;
    stopArchitecture();
    architectureBusy = true;
    reportArchitecture({ status: 'queued' });
    architectureWatch = {};
    renderArchitecture();
    void refreshArchitecture(architectureWatch, true);
  });
  listen('task-baseline', 'change', () => { ownSettings().baseline = $('task-baseline').value; void project(false, true); });
  listen('baseline-create', 'click', async () => {
    if (selection.checkpoint) return;
    const button = $('baseline-create');
    button.disabled = true;
    try {
      const marker = await request('/api/model/v1/checkpoints', { method: 'POST',
        body: JSON.stringify({ label: 'Task baseline', ...(selection.session ? { sessionId: selection.session } : {}) }) });
      ownSettings().baseline = marker.id || marker.checkpoint?.id || marker.marker?.id;
      await loadModel();
    } catch { status('The checkpoint could not be saved. Retry after reconnecting.'); }
    finally { button.disabled = Boolean(selection.checkpoint); }
  });
  listen('model-position', 'change', () => {
    selection.checkpoint = $('model-position').value;
    void loadModel();
  });
  listen('follow-agent', 'change', () => { follow = $('follow-agent').checked; onFollow(follow); void project(); });
  listen('extension-approve', 'click', () => grant(true));
  listen('extension-deny', 'click', () => grant(false));
  listen('analysis-profile', 'change', () => { ownSettings().profile = $('analysis-profile').value; controls(); });
  listen('analysis-access', 'click', () => { const row = descriptor(); if (row?.manifest) consent(row); });
  listen('analysis-run', 'click', async () => {
    const row = descriptor(), profile = profilesFor(row).find(profile => profile.id === $('analysis-profile').value);
    if (analysisBusy || !profile || !row.grant?.approved || !row.grant.profiles?.includes(profile.id) || selection.checkpoint) return;
    const byId = new Map(model.entities.map(entity => [entity.id, entity]));
    const candidates = byId.has(canonicalSelection) ? [canonicalSelection] : model.entities
      .filter(entity => !selection.scope || entity.id === selection.scope || ancestors(entity.id, byId).includes(selection.scope))
      .map(entity => entity.id);
    const entityIds = candidates.filter(id => !profile.selectors?.candidateIds?.length || profile.selectors.candidateIds.includes(id)).slice(0, 256);
    if (!entityIds.length) { status('Select a supported entity in the current scope before running this profile.'); return; }
    analysisBusy = true; controls();
    try {
      const result = await request('/api/extensions/analysis', { method: 'POST',
        body: JSON.stringify({ id: row.id, digest: row.digest, profileId: profile.id, entityIds, revision: model.revision }) });
      if (active === row.id && !closed) status(result.status === 'complete' ? 'Analysis complete.'
        : result.status === 'unavailable' ? 'Analysis is unavailable under the current source-transmission settings or service status.'
        : 'Analysis requested. Accepted results will arrive with model updates.');
    } catch {
      if (active === row.id && !closed) status('Analysis was not accepted. Check profile/data approval and this project’s source-transmission setting.');
    } finally { analysisBusy = false; if (!closed) controls(); }
  });
  document.addEventListener?.('visibilitychange', syncArchitecture);
  listeners.push(() => document.removeEventListener?.('visibilitychange', syncArchitecture));
  controls();
  return {
    async start() { suspended = false; await Promise.all([loadModel(), catalogue()]); },
    choose,
    filter(nextQuery, nextKinds) { query = nextQuery; kinds = nextKinds; void project(false, true); },
    selected(id) { canonicalSelection = id; },
    scope,
    serverSession(id, { projectChanged = false } = {}) {
      if (closed) return;
      serverSessionId = id || undefined;
      selection = { ...(projectChanged ? {} : selection), session: serverSessionId, checkpoint: undefined };
      canonicalSelection = null; focusEntityId = null;
      generation++; projectionController?.abort(); dispose();
      if (!suspended) void loadModel();
      else controls();
    },
    session(id) { selection.session = id || undefined; generation++; dispose(); void loadModel(); },
    live() { selection.checkpoint = undefined; generation++; dispose(); void loadModel(); },
    toggle(id, isCollapsed = true) {
      const own = ownSettings(), expanded = new Set(own.expanded), collapsed = new Set(own.collapsed);
      if (!isCollapsed) { expanded.delete(id); collapsed.add(id); }
      else { expanded.add(id); collapsed.delete(id); }
      own.expanded = [...expanded]; own.collapsed = [...collapsed];
      void project(false, true);
    },
    close() { closed = true; generation++; projectionController?.abort(); client.close(); dispose(); listeners.forEach(remove => remove()); },
    suspend() { suspended = true; loadEpoch++; generation++; projectionController?.abort(); client.suspend(); dispose(); onActivity(null, { ...selection }); },
    get active() { return active; },
    get model() { return model; },
    get selection() { return selection; },
  };
}
