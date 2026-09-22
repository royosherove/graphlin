// This panel consumes public aggregates only. Rendering never starts analysis.
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9 ? value : null;
const amount = (value, label) => value === null || value === undefined ? '' : `${value.toLocaleString('en')} ${label}`;
const parts = values => values.filter(Boolean).join(' · ');
const statuses = ['idle', 'waiting', 'queued', 'running', 'complete', 'partial', 'unavailable'];
const privacyAction = 'Privacy checks withheld source. Remove hardcoded secrets and fallback values; use environment references.';
const reasons = {
  source_consent_required: 'Source analysis is off; available local structure remains visible.',
  source_withheld: `${privacyAction} Some architecture remains unknown.`,
  unsupported_source: 'Some source is unsupported for architecture discovery.',
  source_unavailable: 'Some source could not be captured or processed.',
  missing_key: 'Architecture discovery needs a configured decision service.',
  paused: 'Architecture analysis is paused; local observations can continue.',
  no_source: 'Waiting for eligible source evidence; boundaries remain unknown.',
  unsupported_service: 'The configured service cannot discover architecture.',
  analysis_failed: 'Some architecture checks could not finish. Accepted results remain visible.',
  source_changed: 'Source changed; boundaries need checking against current evidence.',
  partial_coverage: 'Some boundaries remain unknown or unavailable.',
  none_supported: 'No supported application or component boundaries were found.',
  endpoint_unavailable: 'This server does not report architecture progress.',
  request_failed: 'Architecture progress could not be refreshed.',
};
const architectureFields = ['applications', 'components', 'pending', 'inspected', 'attempted', 'analyzed',
  'total', 'withheld', 'unknown', 'unsupported', 'unavailable', 'omitted', 'failures'];

export function normalizeDiscoveryProgress(value) {
  const inventory = value?.inventory;
  if (!['waiting', 'scanning', 'complete', 'partial'].includes(inventory?.status)) return null;
  const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : null;
  return { inventory: { status: inventory.status, startedAt: timestamp(inventory.startedAt),
    finishedAt: timestamp(inventory.finishedAt) },
    ...(typeof value.initialCaptureComplete === 'boolean' ? { initialCaptureComplete: value.initialCaptureComplete } : {}),
    ...(number(value.sourceWithheld) !== null ? { sourceWithheld: number(value.sourceWithheld) } : {}) };
}

function architectureCounts(value) {
  if (!value || !statuses.includes(value.status)) return null;
  return {
    status: value.status, reason: Object.hasOwn(reasons, value.reason) ? value.reason : null,
    ...Object.fromEntries(architectureFields.map(key => [key, number(value[key])])),
  };
}

function coverageCounts(value) {
  if (!value || typeof value !== 'object') return null;
  const input = value.counts || value;
  return {
    ...Object.fromEntries(['inventoried', 'inspected', 'unsupported', 'unavailable', 'excluded']
      .map(key => [key, number(input[key])])),
    complete: value.complete === true || input.complete === true,
    partial: value.truncated === true || value.partial === true || value.client?.truncated === true,
    parsing: Object.fromEntries(['parsed', 'active', 'queued', 'deferred', 'failed', 'omitted']
      .map(key => [key, number(value.parsing?.[key])])),
  };
}

export function discoveryProgressView({
  coverage, architecture, discovery, connection = 'connecting', sourceMode = 'unknown', mode,
  replay = false, scoped = false, external = false, paused = false, classifier,
} = {}) {
  const c = coverageCounts(coverage), p = c?.parsing || {}, a = architectureCounts(architecture);
  const progress = normalizeDiscoveryProgress(discovery), inventory = progress?.inventory;
  const sourceWithheld = progress?.sourceWithheld;
  const capturePending = progress?.initialCaptureComplete === false;
  const inventoryActive = inventory?.status === 'scanning';
  const inventoryComplete = inventory ? inventory.status === 'complete' : c?.complete;
  const local = sourceMode === 'local', metadata = sourceMode === 'metadata';
  const sourceOff = local || metadata || paused || classifier === 'metadata_only';
  const parsingActive = !metadata && (p.active > 0 || p.queued > 0);
  const architectureActive = !sourceOff && ['running', 'queued'].includes(a?.status);
  const active = inventoryActive || parsingActive || architectureActive;
  const limited = c?.partial || scoped || (!metadata && ['deferred', 'failed', 'omitted'].some(key => p[key] > 0))
    || c?.unsupported > 0 || c?.unavailable > 0 || sourceWithheld > 0
    || (!local && !metadata && (paused || ['partial', 'unavailable'].includes(a?.status)
      || ['withheld', 'unknown', 'unsupported', 'unavailable', 'failures', 'omitted'].some(key => a?.[key] > 0)
      || a?.reason === 'none_supported'
      || (a?.status === 'complete' && a.applications === 0 && a.components === 0)));
  const settled = Boolean(inventoryComplete && c?.complete && !capturePending && !active && !limited
    && (metadata || p.active === 0 && p.queued === 0)
    && (local || metadata || a?.status === 'complete'));
  const stages = [
    {
      label: 'Find files', state: inventoryActive ? 'active' : inventoryComplete && !scoped ? 'settled'
        : !c || inventory?.status === 'waiting' ? 'waiting' : 'limited',
      detail: parts([amount(c?.inventoried, 'paths found'), inventoryActive ? 'Finding paths; total still unknown'
        : inventoryComplete ? 'Inventory reported complete'
          : inventory?.status === 'waiting' || !c ? 'Waiting for inventory counts'
            : 'Coverage incomplete; total unknown']),
    },
    {
      label: 'Build source map', state: metadata ? 'optional' : parsingActive ? 'active'
        : capturePending ? 'waiting'
          : sourceWithheld > 0 || ['deferred', 'failed', 'omitted'].some(key => p[key] > 0) ? 'limited' : p.parsed != null ? 'settled' : 'waiting',
      detail: parts([metadata ? 'Off in metadata mode' : capturePending && !c ? 'Awaiting initial source capture'
        : c ? parts([capturePending && 'Awaiting initial source capture', amount(p.parsed, 'processed'),
        p.active > 0 && amount(p.active, 'active'), p.queued > 0 && amount(p.queued, 'queued'),
        p.deferred > 0 && amount(p.deferred, 'deferred'), p.failed > 0 && amount(p.failed, 'failed'),
        p.omitted > 0 && amount(p.omitted, 'omitted'), c.unsupported > 0 && amount(c.unsupported, 'unsupported'),
        c.unavailable > 0 && amount(c.unavailable, 'unavailable')]) || 'Processing counts not reported'
        : 'Waiting for local structure', sourceWithheld > 0 && amount(sourceWithheld, 'withheld from source map')]),
    },
    {
      label: 'Discover architecture', state: local || metadata ? 'optional' : architectureActive ? 'active'
        : limited ? 'limited' : a?.status === 'complete' ? 'settled' : 'waiting',
      detail: local || metadata ? `Optional · off in ${sourceMode} mode` : a ? parts([
        // Legacy "inspected" includes terminal attempts that were not analyzed.
        amount(a.attempted ?? a.inspected, 'attempted'), amount(a.analyzed, 'analyzed'),
        amount(a.pending, 'pending'), amount(a.applications, 'applications'), amount(a.components, 'components'),
        ...['withheld', 'unknown', 'unsupported', 'unavailable', 'failures', 'omitted']
          .filter(key => a[key] > 0).map(key => amount(a[key], key)),
      ]) || 'No work counts reported' : 'Waiting for project analysis status',
    },
  ];
  let title = active ? 'Building your project map' : settled ? 'Map ready · watching for changes'
    : c ? 'Map available · discovery incomplete' : 'Preparing your project map';
  let note = active ? 'Explore while discovery continues. Time remaining is not yet measurable.'
    : settled ? 'Reported work has settled; architectural claims still depend on their evidence.'
      : 'No completion estimate is available. Incomplete coverage may include limits or unavailable evidence.';
  if (local) note = 'Local mode builds the source map on this machine. Architecture analysis is optional and off.';
  if (metadata) note = 'Metadata mode inventories paths without reading or sending source.';
  if (!local && !metadata && a?.reason) note = reasons[a.reason];
  if (!local && !metadata && a?.withheld > 0) note = reasons.source_withheld;
  if (paused && !local && !metadata) note = reasons.paused;
  if (sourceWithheld > 0) note = `${privacyAction} The source map has gaps.`;
  if (active && !note.includes('Time remaining')) note += ' Time remaining is not yet measurable.';
  if (scoped || c?.partial) note += ' File coverage is limited to this view; project-wide completion is not established.';
  let tone = active ? 'active' : settled ? 'settled' : c || limited ? 'limited' : 'waiting';
  if (connection !== 'connected') {
    tone = ['error', 'auth', 'reconnecting'].includes(connection) ? 'error' : 'waiting';
    title = tone === 'error' ? 'Discovery connection interrupted' : 'Opening your project';
    note = connection === 'auth' ? 'Open a fresh viewer link from the local service.'
      : tone === 'error' ? 'Tracking is paused until the local service reconnects. The map remains visible.'
        : 'Waiting for the local service and its discovery counts.';
  }
  if (mode === 'demo' || classifier === 'demo') {
    return { visible: true, active: false, settled: true, tone: 'example', title: 'Example map',
      note: 'Generated examples · no live source analysis.', stages: [], tracking: false };
  }
  if (replay || mode === 'replay') {
    return { visible: true, active: false, settled: false, tone: 'recorded', title: 'Recorded discovery',
      note: 'Return to Live to see current discovery progress.', stages: [], tracking: false };
  }
  return {
    visible: !external, active: connection === 'connected' && active, settled, tone, title, note, stages,
    summary: parts([amount(c?.inventoried, 'paths found'), !metadata && amount(p.parsed, 'processed'),
      !metadata && p.queued > 0 && amount(p.queued, 'queued for processing'),
      !local && !metadata && a?.pending > 0 && amount(a.pending, 'pending architecture checks'),
      sourceWithheld > 0 ? amount(sourceWithheld, 'withheld from source map')
        : !local && !metadata && a?.withheld > 0 && amount(a.withheld, 'withheld')]),
    tracking: connection === 'connected', initial: !c || capturePending,
  };
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function createDiscoveryProgress({ document, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const $ = id => document.getElementById(id), root = $('discovery-progress');
  const preferences = new Map();
  let input = {}, architecture = null, projectId, openedAt = now(), trackingAt = now(), frozenAt = null;
  let closed = false, suspended = false, timer, settledAt = null, initialPass = true, expanded = false;
  function render() {
    cancel(timer);
    if (closed || !root) return;
    const view = discoveryProgressView({ ...input, architecture });
    const instant = now();
    if (!view.tracking || document.hidden || suspended) frozenAt ??= instant;
    else if (frozenAt !== null) { trackingAt += instant - frozenAt; frozenAt = null; }
    const terminal = !view.active && !view.initial && view.tone !== 'waiting';
    if (terminal) settledAt ??= instant;
    else settledAt = null;
    if (initialPass && !view.settled && instant - openedAt >= 500) expanded = true;
    if (settledAt !== null && instant - settledAt >= 5000) { initialPass = false; expanded = false; }
    if (preferences.has(projectId)) expanded = preferences.get(projectId);
    root.hidden = !view.visible;
    root.dataset.state = view.tone;
    $('discovery-title').textContent = view.title;
    $('discovery-note').textContent = view.note;
    $('discovery-summary').textContent = view.summary || '';
    $('discovery-summary').hidden = expanded || !view.summary;
    $('discovery-details').hidden = !expanded || !view.stages.length;
    $('discovery-toggle').hidden = !view.stages.length;
    $('discovery-toggle').textContent = expanded ? 'Less' : 'Progress';
    $('discovery-toggle').setAttribute('aria-expanded', String(expanded));
    for (const [index, stage] of view.stages.entries()) {
      $(`discovery-stage-${index}`).dataset.state = stage.state;
      $(`discovery-stage-${index}`).setAttribute('aria-label', `${stage.label}: ${stage.detail}`);
      $(`discovery-stage-${index}-label`).textContent = stage.label;
      $(`discovery-stage-${index}-detail`).textContent = stage.detail;
    }
    $('discovery-elapsed').textContent = `Tracking for ${duration((frozenAt ?? instant) - trackingAt)}`;
    $('discovery-elapsed').hidden = ['recorded', 'example'].includes(view.tone);
    $('discovery-meter').hidden = !view.active;
    $('discovery-meter').setAttribute('aria-valuetext', 'Work is in progress; remaining time is unknown');
    // The clock and changing counters are intentionally outside the live region.
    if ($('discovery-announcement').textContent !== view.title) $('discovery-announcement').textContent = view.title;
    if (view.visible && !document.hidden && !suspended && !['recorded', 'example', 'error'].includes(view.tone)) {
      timer = schedule(render, initialPass && instant - openedAt < 500 ? 500 - (instant - openedAt) : 1000);
      timer?.unref?.();
    }
  }
  function toggle() {
    expanded = !expanded;
    preferences.set(projectId, expanded);
    while (preferences.size > 32) preferences.delete(preferences.keys().next().value);
    render();
  }
  const visibility = () => render();
  $('discovery-toggle')?.addEventListener('click', toggle);
  document.addEventListener('visibilitychange', visibility);
  render();
  return {
    update(value) {
      if (closed) return;
      if (value.projectId && value.projectId !== projectId) {
        architecture = null; initialPass = true; expanded = false; settledAt = null;
        if (projectId) { openedAt = trackingAt = now(); frozenAt = null; }
        projectId = value.projectId;
      }
      // Retain only aggregates and fixed enums, never model records or evidence.
      input = {
        coverage: coverageCounts(value.coverage), connection: value.connection,
        discovery: normalizeDiscoveryProgress(value.discovery),
        mode: value.mode, sourceMode: value.sourceMode, classifier: value.classifier,
        paused: value.paused === true, scoped: value.scoped === true,
        replay: value.replay === true, external: value.external === true,
      };
      suspended = false;
      render();
    },
    architecture(value) { architecture = architectureCounts(value); render(); },
    suspend() { suspended = true; render(); },
    close() {
      closed = true; cancel(timer);
      $('discovery-toggle')?.removeEventListener('click', toggle);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
