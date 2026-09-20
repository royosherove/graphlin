import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeDiagnostics, filterDiagnostics, startDiagnosticsDialog } from '../../runtime/web/app.js';
import { createDocument, Element } from './fake-dom.mjs';

// Keep the shared fake DOM's mutation machinery, but expose the browser's
// children contract to application code: a live iterable HTMLCollection with
// item()/namedItem(), indexed access and no Array methods.
function useHTMLCollections(document) {
  let insideFakeDOM = false;
  const internal = callback => function (...args) {
    const previous = insideFakeDOM;
    insideFakeDOM = true;
    try { return callback.apply(this, args); } finally { insideFakeDOM = previous; }
  };
  function wrap(element) {
    let children = element.children;
    const collection = new Proxy(Object.create(null), {
      get(_target, key) {
        if (key === 'length') return children.length;
        if (key === 'item') return index => children[index] || null;
        if (key === 'namedItem') return name => children.find(child => child.getAttribute('id') === name || child.getAttribute('name') === name) || null;
        if (key === Symbol.iterator) return children[Symbol.iterator].bind(children);
        if (key === Symbol.toStringTag) return 'HTMLCollection';
        if (typeof key === 'string' && /^\d+$/.test(key)) return children[Number(key)];
        return undefined;
      },
    });
    Object.defineProperty(element, 'children', {
      get: () => insideFakeDOM ? children : collection,
      set(value) {
        if (!insideFakeDOM) throw new TypeError('children is read-only');
        children = value;
      },
    });
    for (const name of ['append', 'insertBefore', 'replaceChildren', 'remove', 'contains', 'querySelector']) {
      element[name] = internal(element[name]);
    }
    const text = Object.getOwnPropertyDescriptor(Element.prototype, 'textContent');
    Object.defineProperty(element, 'textContent', { get: internal(text.get), set: internal(text.set) });
    return element;
  }
  for (const element of [document.body, ...document.elements.values()]) wrap(element);
  const create = document.createElement.bind(document), createNS = document.createElementNS.bind(document);
  document.createElement = tag => wrap(create(tag));
  document.createElementNS = (namespace, tag) => wrap(createNS(namespace, tag));
}

function logRecord(sequence = 1, overrides = {}) {
  return {
    id: `diagnostic-${sequence}`, sequence, at: '2026-09-19T12:30:01.000Z',
    stage: 'classification', eventId: `event-${sequence}`, sourceEventId: 'source-event',
    sessionId: 'session-a', eventKind: 'tool.succeeded', toolCategory: 'read',
    status: 'abstained', reason: 'no_accepted_classification',
    artifacts: [{ artifactId: 'artifact-1', path: 'src/notes.mjs', status: 'present', complete: true, candidateCount: 2 }],
    candidates: [{
      candidateId: 'candidate-1', artifactId: 'artifact-1', label: 'saveNote',
      sourceClass: 'source', startLine: 12, endLine: 19, complete: true,
    }, {
      candidateId: 'candidate-2', artifactId: 'artifact-1', label: 'PostgreSQL',
      sourceClass: 'source', startLine: 3, endLine: 7, complete: true,
    }],
    diagnostics: {
      code: 'no_accepted_classification', durationMs: 123, calls: 2, candidatesOmitted: 3, proposalsOmitted: 4,
      questionCounts: { A: 5, B: 12 }, stageDurationMs: { A: 45, B: 62 },
      extraction: [{ artifactId: 'artifact-1', available: 8, selected: 2, reason: 'candidate_limit' }],
      admission: [{ candidateId: 'candidate-1', status: 'skipped', reason: 'below_drawing_floor' }],
      trace: {
        activity: { choice: 'implement', confidence: .92, probabilities: {
          inspect: .01, propose: .01, implement: .9, verify: .02, repair: .03, explain: .01, other: .02,
        } },
        thresholds: { intake: { relevantMin: .65, sensitiveMax: .1 }, admission: { nodeSupportMin: .9 } },
        relevance: .95,
        intake: [{ candidateId: 'candidate-1', relevant: .97, sensitive: 0, approved: true, reason: 'ok' }],
        nodes: [{ candidateId: 'candidate-1', role: 'function', supportProbability: .42,
          roleProbability: .88, roleConfidence: .77, classification: 'tentative', reasons: ['below_threshold'] }],
        edges: [{ proposalId: 'proposal-1', sourceCandidateId: 'candidate-1', targetCandidateId: 'candidate-2',
          relation: 'writes', evidenceCandidateIds: ['candidate-1'], supportProbability: .2,
          missingContextProbability: .4, classification: 'tentative', reasons: ['missing_context'] }],
        requests: [{ stage: 'B', model: 'jev-1.13.0', rubricVersion: 'graphlin-v2', status: 'accepted', code: 'ok',
          durationMs: 62, questionCount: 12, requestBytes: 2048 }],
      },
    },
    patch: { revisionBefore: 3, revisionAfter: 3, nodesAdded: 0, nodesUpdated: 0, nodesRemoved: 0,
      edgesAdded: 0, edgesUpdated: 0, edgesRemoved: 0 },
    ...overrides,
  };
}
function payload(records = [logRecord()]) {
  return { schemaVersion: 1, records, stats: { recordCount: records.length, dropped: 0 }, logPath: '/fixture/private/diagnostics.jsonl' };
}
async function setup({ load = async () => payload(), currentSession = () => 'session-a', useDefaultLoader = false } = {}) {
  const markup = await readFile(new URL('../../runtime/web/index.html', import.meta.url), 'utf8');
  const document = createDocument(markup);
  useHTMLCollections(document);
  const keys = ['document', 'fetch'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.document = document;
  const controller = startDiagnosticsDialog({ ...(!useDefaultLoader && { load }), currentSession });
  return {
    controller, document, markup, $: id => document.getElementById(id),
    close() {
      controller.dispose();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}
function descendants(element, tag) {
  return Array.from(element.children).flatMap(child => [...(child.tagName === tag ? [child] : []), ...descendants(child, tag)]);
}
async function expand(element) { element.open = true; await element.fire('toggle'); }

test('diagnostics normalization retains bounded scores and reason codes, excludes raw input/credentials, and never fabricates missing scores', () => {
  const raw = payload();
  const entry = raw.records[0];
  raw.apiKey = 'DO_NOT_DISPLAY_ROOT_SECRET';
  raw.stats.authorization = 'DO_NOT_DISPLAY_STATS_SECRET';
  entry.rawSource = 'DO_NOT_DISPLAY_RAW_SOURCE';
  entry.prompt = 'DO_NOT_DISPLAY_PROMPT';
  entry.artifacts[0].contents = 'DO_NOT_DISPLAY_FILE_CONTENT';
  entry.candidates[0].text = 'DO_NOT_DISPLAY_CANDIDATE_TEXT';
  entry.diagnostics.trace.nodes[0].apiKey = 'DO_NOT_DISPLAY_NODE_SECRET';
  entry.diagnostics.trace.requests[0].headers = { authorization: 'DO_NOT_DISPLAY_REQUEST_SECRET' };
  entry.diagnostics.trace.requests[0].response = 'DO_NOT_DISPLAY_MODEL_BODY';
  entry.diagnostics.trace.activity.prompt = 'DO_NOT_DISPLAY_ACTIVITY_PROMPT';
  entry.diagnostics.trace.activity.probabilities.rawSource = 'DO_NOT_DISPLAY_ACTIVITY_SOURCE';
  entry.diagnostics.trace.intake[0].relevant = '0.9';
  entry.diagnostics.trace.nodes[0].roleConfidence = Infinity;
  const before = structuredClone(raw);
  const safe = normalizeDiagnostics(raw);
  assert.doesNotMatch(JSON.stringify(safe), /DO_NOT_DISPLAY/);
  assert.deepEqual(raw, before, 'render intake cannot mutate diagnostic records');
  assert.equal(safe.records[0].diagnostics.trace.intake[0].relevant, null);
  assert.equal(safe.records[0].diagnostics.trace.intake[0].sensitive, 0);
  assert.equal(safe.records[0].diagnostics.trace.intake[0].approved, true);
  assert.equal(safe.records[0].diagnostics.trace.nodes[0].roleConfidence, null);
  assert.equal(safe.records[0].patch.nodesAdded, 0);
  assert.deepEqual(safe.records[0].diagnostics.trace.thresholds.intake, { relevantMin: .65, sensitiveMax: .1 });
  assert.equal(safe.records[0].diagnostics.trace.requests[0].model, 'jev-1.13.0');
  assert.deepEqual(safe.records[0].diagnostics.trace.nodes[0].reasons, ['below_threshold']);
  assert.equal(safe.records[0].diagnostics.extraction[0].available, 8);
  assert.equal(safe.records[0].diagnostics.admission[0].reason, 'below_drawing_floor');
  assert.throws(() => normalizeDiagnostics({ schemaVersion: 2, records: [] }), /invalid_diagnostics/);
  assert.throws(() => normalizeDiagnostics({ records: [] }), /invalid_diagnostics/);
  const sparse = normalizeDiagnostics(payload([{ stage: '<script>', at: 'invalid', reason: '<img>', seq: 8 }])).records[0];
  assert.equal(sparse.stage, 'unknown');
  assert.equal(sparse.at, null);
  assert.equal(sparse.reason, '');
  assert.equal(sparse.sequence, 8);
  assert.equal(sparse.diagnostics.trace.relevance, null);
  assert.equal(sparse.diagnostics.trace.activity, null);
});

test('activity routing retains every finite choice and distribution without defaulting missing or invalid decisions', () => {
  const activities = ['inspect', 'propose', 'implement', 'verify', 'repair', 'explain', 'other'];
  for (const choice of activities) {
    const entry = logRecord();
    const distribution = Object.fromEntries(activities.map(activity => [activity, activity === choice ? 1 : 0]));
    entry.diagnostics.trace.activity = { choice, confidence: 0, probabilities: distribution };
    entry.diagnostics.trace.nodes[0].roleProbabilities = { function: .88, class: .1, unknown: .02, invented: .4 };
    const result = normalizeDiagnostics(payload([entry])).records[0];
    assert.deepEqual(result.diagnostics.trace.activity, { choice, confidence: 0, probabilities: distribution });
    assert.deepEqual(result.diagnostics.trace.nodes[0].roleProbabilities, { function: .88, class: .1, unknown: .02 });
    assert.equal(filterDiagnostics([result], { query: choice }).length, 1);
  }
  for (const activity of [null, undefined, {}, { choice: '<script>' }, { choice: 'invented', confidence: 1 }]) {
    const entry = logRecord();
    entry.diagnostics.trace.activity = activity;
    assert.equal(normalizeDiagnostics(payload([entry])).records[0].diagnostics.trace.activity, null);
  }
  const entry = logRecord();
  entry.diagnostics.trace.activity = {
    choice: 'inspect', confidence: Infinity,
    probabilities: { inspect: '1', propose: NaN, implement: -1, verify: 2, repair: .25, explain: 0, other: 1, secret: .5 },
  };
  assert.deepEqual(normalizeDiagnostics(payload([entry])).records[0].diagnostics.trace.activity, {
    choice: 'inspect', confidence: null, probabilities: { repair: .25, explain: 0, other: 1 },
  });
});

test('activity choice and confidence appear in readable details and JSON, and server truncation is disclosed without inventing scores', async () => {
  const truncated = logRecord(2, { truncated: true, diagnostics: { trace: { activity: null } } });
  const falseFlag = logRecord(3, { truncated: 'true' });
  assert.equal(normalizeDiagnostics(payload([truncated])).records[0].trimmed, true);
  assert.equal(normalizeDiagnostics(payload([falseFlag])).records[0].trimmed, false);
  const h = await setup({ load: async () => payload([logRecord(), truncated]) });
  try {
    await h.$('classification-log').fire('click');
    const [limited, classified] = h.$('diagnostics-records').children;
    await expand(classified);
    const facts = descendants(classified, 'dl')[0].textContent;
    assert.match(facts, /Activity classificationImplement/);
    assert.match(facts, /Activity confidence92%/);
    const json = JSON.parse(descendants(classified, 'pre')[0].textContent);
    assert.equal(json.diagnostics.trace.activity.choice, 'implement');
    assert.equal(json.diagnostics.trace.activity.probabilities.implement, .9);
    assert.equal(Object.keys(json.diagnostics.trace.activity.probabilities).length, 7);
    await expand(limited);
    assert.match(limited.textContent, /Not recorded at this stage/);
    assert.match(limited.textContent, /The server abbreviated this record/);
    const limitedJSON = JSON.parse(descendants(limited, 'pre')[0].textContent);
    assert.equal(limitedJSON.truncated, true);
    assert.equal(limitedJSON.diagnostics.trace.activity, null);
    assert.doesNotMatch(descendants(limited, 'dl')[0].textContent, /Activity confidence/);
  } finally { h.close(); }
});

test('details expand with native-like live HTMLCollections and keep keyboard access to every table and JSON', async () => {
  const h = await setup();
  try {
    await h.$('classification-log').fire('click');
    const rows = h.$('diagnostics-records').children, row = rows.item(0);
    assert.equal(Array.isArray(rows), false);
    assert.equal(rows.filter, undefined);
    assert.equal(Object.prototype.toString.call(rows), '[object HTMLCollection]');
    const children = row.children;
    assert.equal(children.length, 1);
    await expand(row);
    assert.equal(children.length, 2, 'the same collection reflects the appended detail body');
    const detail = children.item(1);
    assert.equal(detail.className, 'diagnostics-detail');
    assert.equal(detail.children.filter, undefined);
    assert.match(detail.textContent, /Activity confidence92%/);
    const tables = descendants(detail, 'div').filter(item => item.className === 'diagnostics-table-wrap');
    assert.equal(tables.length, 8);
    const pre = descendants(detail, 'pre')[0];
    h.$('diagnostics-close').focus();
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(h.document.activeElement, pre);
    tables[0].focus();
    let prevented = false;
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'a table is recognized inside the trap and native Tab can continue');
  } finally { h.close(); }
});

test('request timing, timeout outcome, model, rubric and effective thresholds are readable before intake and score tables', async () => {
  const entry = logRecord();
  entry.diagnostics.durationMs = 2000;
  entry.diagnostics.trace.requests = [
    { stage: 'A', model: 'jev-1.13.0', rubricVersion: 'intake-v2', status: 'accepted', code: 'ok', durationMs: 1315, questionCount: 5 },
    { stage: 'B', model: 'jev-1.13.0', rubricVersion: 'architecture-v2', status: 'timeout', code: 'deadline_exceeded', durationMs: 685, questionCount: 12 },
  ];
  entry.diagnostics.trace.thresholds = {
    intake: { relevantMin: .65, sensitiveMax: .1 },
    admission: { relevanceMin: .65, nodeSupportMin: .9, roleProbabilityMin: .8,
      roleConfidenceMin: .7, edgeSupportMin: .9, missingContextMax: .1 },
  };
  entry.diagnostics.trace.intake[0].materialized = false;
  const h = await setup({ load: async () => payload([entry]) });
  try {
    await h.$('classification-log').fire('click');
    const row = h.$('diagnostics-records').children[0];
    await expand(row);
    const tables = descendants(row, 'table');
    const names = tables.map(table => table.getAttribute('aria-label'));
    const requests = tables.find(table => table.getAttribute('aria-label') === 'Classifier requests');
    assert.deepEqual(descendants(requests, 'td').map(cell => cell.textContent), [
      'A / jev-1.13.0 / intake-v2', '1315 ms', 'Accepted / ok', '5',
      'B / jev-1.13.0 / architecture-v2', '685 ms', 'Timeout / deadline_exceeded', '12',
    ]);
    const thresholds = tables.find(table => table.getAttribute('aria-label') === 'Decision thresholds');
    assert.deepEqual(descendants(thresholds, 'td').map(cell => cell.textContent), [
      'Intake', 'Minimum relevance', '65%', 'Intake', 'Maximum sensitivity', '10%',
      'Admission', 'Minimum relevance', '65%', 'Admission', 'Minimum component support', '90%',
      'Admission', 'Minimum role probability', '80%', 'Admission', 'Minimum role confidence', '70%',
      'Admission', 'Minimum relationship support', '90%', 'Admission', 'Maximum missing context', '10%',
    ]);
    assert.ok(names.indexOf('Classifier requests') < names.indexOf('Decision thresholds'));
    assert.ok(names.indexOf('Decision thresholds') < names.indexOf('Intake checks'));
    assert.ok(names.indexOf('Decision thresholds') < names.indexOf('Component scores'));
    assert.equal(requests.parentElement.getAttribute('tabindex'), '0');
    assert.equal(thresholds.parentElement.getAttribute('tabindex'), '0');
    const intake = tables.find(table => table.getAttribute('aria-label') === 'Intake checks');
    assert.deepEqual(descendants(intake, 'th').map(cell => cell.textContent),
      ['Candidate', 'Relevant', 'Sensitive', 'Passes intake', 'Sent to architecture', 'Reason']);
    assert.deepEqual(descendants(intake, 'td').map(cell => cell.textContent),
      ['saveNote', '97%', '0%', 'Yes', 'No', 'Ok'], 'passing intake does not claim that the candidate reached architecture classification');
  } finally { h.close(); }
});

test('bounded source inspection reports an available lower bound while an exact candidate cap keeps its exact count', async () => {
  const entry = logRecord();
  entry.diagnostics.extraction = [
    { artifactId: 'artifact-1', available: 12, selected: 12, truncated: true, reason: 'snippet_limit' },
    { artifactId: 'artifact-1', available: 13, selected: 12, truncated: false, reason: 'candidate_limit' },
  ];
  const normalized = normalizeDiagnostics(payload([entry])).records[0];
  assert.equal(normalized.diagnostics.extraction[0].truncated, true);
  assert.equal(normalized.diagnostics.extraction[1].truncated, false);
  assert.equal(normalized.trimmed, false, 'bounded inspection is distinct from an abbreviated diagnostic record');
  const h = await setup({ load: async () => payload([entry]) });
  try {
    await h.$('classification-log').fire('click');
    const row = h.$('diagnostics-records').children[0];
    await expand(row);
    const table = descendants(row, 'table').find(item => item.getAttribute('aria-label') === 'Candidate discovery');
    const cells = descendants(table, 'td').map(cell => cell.textContent);
    assert.deepEqual(cells, [
      'src/notes.mjs', '12+', '12', 'Source window limit reached',
      'src/notes.mjs', '13', '12', 'Candidate limit',
    ]);
    const json = JSON.parse(descendants(row, 'pre')[0].textContent);
    assert.equal(json.diagnostics.extraction[0].truncated, true);
  } finally { h.close(); }
});

test('log intake and list rendering are bounded, newest first, and searchable by file, label, event, source event or session', async () => {
  const entries = Array.from({ length: 340 }, (_, index) => logRecord(index + 1));
  entries[339].artifacts = Array.from({ length: 100 }, () => entries[0].artifacts[0]);
  entries[339].diagnostics.trace.nodes = Array.from({ length: 100 }, () => logRecord().diagnostics.trace.nodes[0]);
  const safe = normalizeDiagnostics(payload(entries));
  assert.equal(safe.records.length, 300);
  assert.equal(safe.omitted, 40);
  assert.equal(safe.records[0].sequence, 41);
  assert.equal(safe.records.at(-1).artifacts.length, 24);
  assert.equal(safe.records.at(-1).diagnostics.trace.nodes.length, 48);
  assert.equal(safe.records.at(-1).trimmed, true);
  for (const query of ['SRC/NOTES.MJS', 'saveNote', 'source-event', 'event-340', 'session-a']) {
    assert.ok(filterDiagnostics(safe.records, { query }).length > 0, query);
  }
  assert.equal(filterDiagnostics(safe.records, { query: 'saveNote absent' }).length, 0);
  assert.equal(filterDiagnostics(safe.records, { sessionId: 'other-session' }).length, 0);
  const h = await setup({ load: async () => payload(entries) });
  try {
    await h.$('classification-log').fire('click');
    assert.equal(h.$('diagnostics-records').children.length, 100);
    assert.match(h.$('diagnostics-count').textContent, /Showing 100 of 300/);
    assert.match(h.$('diagnostics-count').textContent, /40 older or unsupported/);
    assert.equal(descendants(h.$('diagnostics-records'), 'pre').length, 0, 'detail DOM is created only when expanded');
    await expand(h.$('diagnostics-records').children[0]);
    assert.match(descendants(h.$('diagnostics-records'), 'pre')[0].textContent, /"sequence": 340/);
    assert.match(h.$('diagnostics-records').textContent, /Details are abbreviated/);
  } finally { h.close(); }
});

test('the dialog loads on demand, defaults to the current session, offers all sessions and independent search without changing the chosen session', async () => {
  let calls = 0;
  const h = await setup({ load: async () => {
    calls++;
    return payload([logRecord(1), logRecord(2, { sessionId: 'session-b', artifacts: [{ artifactId: 'other', path: 'lib/worker.mjs' }] })]);
  } });
  try {
    assert.equal(calls, 0);
    assert.match(h.markup, /id="classification-log"[^>]*aria-haspopup="dialog"/);
    assert.match(h.markup, /<dialog id="diagnostics-dialog"[^>]*aria-labelledby="diagnostics-title"/);
    h.$('classification-log').focus();
    await h.$('classification-log').fire('click');
    assert.equal(h.$('diagnostics-dialog').open, true);
    assert.equal(h.$('diagnostics-session').value, 'current');
    assert.equal(h.document.activeElement, h.$('diagnostics-close'));
    assert.equal(h.$('diagnostics-records').children.length, 1);
    h.$('diagnostics-session').value = 'all';
    await h.$('diagnostics-session').fire('change');
    assert.equal(h.$('diagnostics-records').children.length, 2);
    assert.match(h.$('diagnostics-records').children[0].textContent, /lib\/worker\.mjs/);
    h.$('diagnostics-search').value = 'lib/worker session-b';
    h.$('diagnostics-search').focus();
    await h.$('diagnostics-search').fire('input');
    assert.equal(h.$('diagnostics-records').children.length, 1);
    assert.equal(h.document.activeElement, h.$('diagnostics-search'));
    assert.equal(calls, 1, 'filtering is local and never requests a session switch');
    h.$('diagnostics-search').value = 'nonexistent';
    await h.$('diagnostics-search').fire('input');
    assert.equal(h.$('diagnostics-empty').hidden, false);
    assert.match(h.$('diagnostics-empty').textContent, /No records match/);
    await h.$('diagnostics-close').fire('click');
    assert.equal(h.document.activeElement, h.$('classification-log'));
    assert.equal(h.$('diagnostics-records').children.length, 0);
    assert.equal(h.$('diagnostics-log-path').textContent, '');
    await h.$('classification-log').fire('click');
    assert.equal(calls, 2);
    assert.equal(h.$('diagnostics-session').value, 'current');
    assert.equal(h.$('diagnostics-search').value, '');
  } finally { h.close(); }
});

test('readable details expose stage, score, reason, file and graph changes as literal text and trap focus around lazy detail controls', async () => {
  const entry = logRecord();
  entry.artifacts[0].path = 'src/<img src=x>.mjs';
  entry.candidates[0].label = '<script>saveNote</script>';
  entry.diagnostics.trace.nodes[0].roleConfidence = null;
  const h = await setup({ load: async () => payload([entry]) });
  try {
    h.$('classification-log').focus();
    await h.$('classification-log').fire('click');
    const row = h.$('diagnostics-records').children[0];
    assert.match(row.textContent, /Classification/);
    assert.match(row.textContent, /No classification met acceptance requirements/);
    assert.ok(row.textContent.includes('src/<img src=x>.mjs'));
    const summary = row.children[0];
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(h.document.activeElement, summary);
    await expand(row);
    assert.match(row.textContent, /Component scores/);
    assert.match(row.textContent, /Candidate discovery/);
    assert.match(row.textContent, /Drawing decisions/);
    assert.match(row.textContent, /Support was too low to draw/);
    assert.match(row.textContent, /42%/);
    assert.match(row.textContent, /88%/);
    assert.match(row.textContent, /Not reported/);
    assert.match(row.textContent, /Below threshold/);
    assert.match(row.textContent, /20%/);
    assert.match(row.textContent, /Missing context/);
    assert.match(row.textContent, /3 → 3/);
    assert.match(row.textContent, /added: 0, updated: 0, removed: 0/);
    assert.equal(row.querySelector('img'), null);
    assert.equal(row.querySelector('script'), null);
    const pre = descendants(row, 'pre')[0];
    const tables = descendants(row, 'div').filter(item => item.className === 'diagnostics-table-wrap');
    assert.ok(tables.every(item => item.getAttribute('tabindex') === '0'), 'narrow-screen tables are keyboard scrollable');
    assert.ok(pre.textContent.includes('<script>saveNote</script>'));
    pre.focus();
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Tab' });
    assert.equal(h.document.activeElement, h.$('diagnostics-close'));
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Tab', shiftKey: true });
    assert.equal(h.document.activeElement, pre);
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Escape' });
    assert.equal(h.$('diagnostics-dialog').open, false);
    assert.equal(h.document.activeElement, h.$('classification-log'));
  } finally { h.close(); }
});

test('manual refresh preserves expansion and failed refresh retains previous records; older daemons explain restarting and unavailable historical scores', async () => {
  let fail = 'old', calls = 0;
  const h = await setup({ load: async () => {
    calls++;
    if (fail) throw Object.assign(new Error('request_failed'), { status: fail === 'old' ? 404 : 503 });
    return payload();
  } });
  try {
    await h.$('classification-log').fire('click');
    assert.match(h.$('diagnostics-error').textContent, /Restart the updated local server/);
    assert.match(h.$('diagnostics-error').textContent, /Earlier scores cannot be recovered/);
    assert.equal(h.$('diagnostics-refresh').disabled, false);
    fail = '';
    await h.$('diagnostics-refresh').fire('click');
    assert.equal(h.$('diagnostics-error').hidden, true);
    await expand(h.$('diagnostics-records').children[0]);
    await h.$('diagnostics-refresh').fire('click');
    assert.equal(h.$('diagnostics-records').children[0].open, true);
    assert.equal(descendants(h.$('diagnostics-records'), 'pre').length, 1);
    fail = 'network';
    await h.$('diagnostics-refresh').fire('click');
    assert.equal(h.$('diagnostics-records').children.length, 1);
    assert.match(h.$('diagnostics-error').textContent, /Showing the last loaded records/);
    assert.equal(calls, 4, 'only open and manual refresh load the log');
    await h.$('diagnostics-dialog').fire('cancel');
    assert.equal(h.$('diagnostics-dialog').open, false);
  } finally { h.close(); }
});

test('closing, reopening and disposal reject stale asynchronous responses, clear data and do not leave loading controls disabled', async () => {
  let resolveFirst, calls = 0;
  const h = await setup({ load: () => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(payload([logRecord(2)])) });
  try {
    const first = h.$('classification-log').fire('click');
    assert.equal(h.$('diagnostics-loading').hidden, false);
    assert.equal(h.$('diagnostics-records').getAttribute('aria-busy'), 'true');
    await h.$('diagnostics-close').fire('click');
    await h.$('classification-log').fire('click');
    await h.$('diagnostics-dialog').fire('close');
    assert.equal(h.$('diagnostics-dialog').open, true, 'delayed native close cannot hide a reopened dialog');
    resolveFirst(payload([logRecord(1)]));
    await first;
    assert.equal(h.$('diagnostics-refresh').disabled, false);
    assert.equal(h.$('diagnostics-loading').hidden, true);
    await expand(h.$('diagnostics-records').children[0]);
    assert.match(descendants(h.$('diagnostics-records'), 'pre')[0].textContent, /"sequence": 2/);
    h.controller.dispose();
    assert.equal(h.$('diagnostics-dialog').open, false);
    assert.equal(h.$('diagnostics-records').children.length, 0);
    await h.$('classification-log').fire('click');
    assert.equal(calls, 2);
  } finally { h.close(); }
});

test('close, replacement and disposal abort the actual fetch signals and release request deadline timers', async t => {
  const h = await setup({ useDefaultLoader: true });
  const requests = [], timers = new Set();
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, duration, ...args) => {
    const timer = setTimer(callback, duration, ...args);
    if (duration === 8000) timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); clearTimer(timer); });
  let active = 0, maximumActive = 0;
  globalThis.fetch = (path, { signal }) => {
    assert.equal(path, '/api/diagnostics');
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    requests.push(signal);
    active++;
    maximumActive = Math.max(maximumActive, active);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
    });
  };
  try {
    const first = h.$('classification-log').fire('click');
    assert.equal(active, 1);
    assert.equal(timers.size, 1);
    await h.$('diagnostics-close').fire('click');
    await first;
    assert.equal(requests[0].aborted, true, 'closing cancels the signal passed to fetch');
    assert.equal(active, 0);
    assert.equal(timers.size, 0);

    const second = h.$('classification-log').fire('click');
    const replacement = h.$('diagnostics-refresh').fire('click');
    await second;
    assert.equal(requests[1].aborted, true, 'a replacement cancels the old request before dispatching another');
    assert.equal(requests[2].aborted, false);
    assert.equal(active, 1);
    assert.equal(timers.size, 1, 'the superseded request does not retain its eight-second deadline');
    h.controller.dispose();
    await replacement;
    assert.equal(requests[2].aborted, true, 'disposal cancels the remaining fetch');
    assert.equal(active, 0);
    assert.equal(maximumActive, 1, 'reopening and replacement cannot accumulate requests');
    assert.equal(timers.size, 0);
    assert.equal(h.$('diagnostics-error').hidden, true, 'intentional cancellation does not become a service error');
    assert.equal(h.$('diagnostics-records').childElementCount, 0);
  } finally {
    h.close();
    t.mock.restoreAll();
  }
});

test('a dialog cancels its injected loader signal and a response body still being read', async () => {
  let injectedSignal;
  const injected = await setup({ load: ({ signal }) => {
    injectedSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  try {
    const opening = injected.$('classification-log').fire('click');
    assert.equal(injectedSignal.aborted, false);
    await injected.$('diagnostics-dialog').fire('cancel');
    await opening;
    assert.equal(injectedSignal.aborted, true, 'the dialog owns a signal even with a custom loader');
  } finally { injected.close(); }

  const h = await setup({ useDefaultLoader: true });
  let fetchSignal, reading;
  const bodyStarted = new Promise(resolve => { reading = resolve; });
  globalThis.fetch = async (_path, { signal }) => {
    fetchSignal = signal;
    return {
      ok: true, headers: { get: () => null },
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        reading();
      }),
    };
  };
  try {
    const opening = h.$('classification-log').fire('click');
    await bodyStarted;
    assert.equal(fetchSignal.aborted, false);
    await h.$('diagnostics-dialog').fire('keydown', { key: 'Escape' });
    await opening;
    assert.equal(fetchSignal.aborted, true, 'headers arriving do not relinquish ownership of the pending body');
    assert.equal(h.$('diagnostics-loading').hidden, true);
    assert.equal(h.$('diagnostics-records').childElementCount, 0);
  } finally { h.close(); }
});

test('the default loader uses only authenticated GET diagnostics; no-session and empty logs give an actionable state', async () => {
  const h = await setup({ useDefaultLoader: true, currentSession: () => '' });
  try {
    const requests = [];
    globalThis.fetch = async (path, options) => {
      requests.push({ path, options });
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(payload([])) };
    };
    await h.$('classification-log').fire('click');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/diagnostics');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.equal(requests[0].options.body, undefined);
    assert.equal(h.$('diagnostics-session').value, 'all');
    assert.equal(h.$('diagnostics-session').children[0].disabled, true);
    assert.equal(h.$('diagnostics-empty').hidden, false);
    assert.match(h.$('diagnostics-empty').textContent, /let your agent read or change a file/);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await h.$('diagnostics-refresh').fire('click');
    assert.match(h.$('diagnostics-error').textContent, /Restart the updated local server/);
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await h.$('diagnostics-refresh').fire('click');
    assert.match(h.$('diagnostics-error').textContent, /Reopen a fresh viewer link/);
  } finally { h.close(); }
});

test('skipped and failed records offer targeted next actions without displaying raw failure content', async () => {
  const reasons = [
    ['metadata_only', /review source consent/],
    ['paused_deferred', /Resume classification/],
    ['classifier_unavailable', /TypeSafe key/],
    ['deadline_exceeded', /classifier connection/],
    ['source_changed_during_classification', /latest file version/],
    ['no_candidates', /main implementation files/],
    ['classification_queue_full', /queued work finish/],
  ];
  const h = await setup({ load: async () => payload(reasons.map(([reason], index) =>
    logRecord(index + 1, {
      stage: 'skip', status: 'skipped', reason,
      error: 'fixture-raw-secret', payload: { apiKey: 'fixture-private-key' },
    }))) });
  try {
    await h.$('classification-log').fire('click');
    for (const [, pattern] of reasons) assert.match(h.$('diagnostics-records').textContent, pattern);
    assert.doesNotMatch(h.$('diagnostics-records').textContent, /fixture-raw-secret|fixture-private-key/);
    await expand(h.$('diagnostics-records').children[0]);
    assert.doesNotMatch(h.$('diagnostics-records').textContent, /fixture-raw-secret|fixture-private-key/);
  } finally { h.close(); }
});
