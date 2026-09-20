import path from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDecisionService, createFixtureTransport } from '../jev/index.mjs';
import { materializeBundle, buildRelationProposals } from '../core/index.mjs';
import { defaultDataDir, privateDirectory, canonicalProjectRoot, runtimeError } from './paths.mjs';

const DATABASE = `// Offline source fixture. This code never connects to a database.
export const PostgreSQL = {
  query(statement, values) { return Promise.resolve({ statement, values }); }
};
`;
const REPOSITORY = `import { PostgreSQL } from './database.mjs';
export function saveNote(note) {
  return PostgreSQL.query('INSERT INTO notes(body) VALUES ($1)', [note.body]);
}
`;

// Small independent artifacts keep every recording within the real 12-candidate,
// seven-relation proposal budget. Nothing here is evaluated or imported.
const FIXTURES = Object.freeze({
  'database.mjs': DATABASE,
  'notes.mjs': REPOSITORY,
  'hierarchy.mjs': `// Offline source fixture: a three-step notes path.
export function createNote(note) { return persistNote(note); }
export function persistNote(note) { return NoteCache.put(note); }
export const NoteCache = { put(note) { return note; } };
`,
  'strategies.mjs': `// Offline source fixture: reciprocal strategy references.
export class WarmGreetingStrategy {
  greet() { return EnthusiasticGreetingStrategy.render(); }
}
export class EnthusiasticGreetingStrategy {
  static render() { return WarmGreetingStrategy.prototype.greet(); }
}
`,
  'browser.mjs': `// Offline source fixture: browser UI submits to a local service.
export const BrowserNotesApplication = {
  submit(note) { return NotesApplicationService.create(note); }
};
export const NotesApplicationService = { create(note) { return note; } };
`,
  'notifications.mjs': `// Offline source fixture: a worker consumes a queue; no process runs.
export const NotificationDeliveryService = {
  poll() { return PendingNotificationsQueue.take(); }
};
export const PendingNotificationsQueue = { take() { return []; } };
`,
  'provider.mjs': `// Offline source fixture: an external adapter depends on configuration.
export const ExternalGreetingProvider = {
  describe() { return GreetingRuntimeConfiguration.provider; }
};
export const GreetingRuntimeConfiguration = { provider: 'offline-example' };
`,
  'toolkit.mjs': `// Offline source fixture: a module uses a package facade.
export const TextFormattingModule = {
  format(text) { return GreetingToolkitPackage.format(text); }
};
export const GreetingToolkitPackage = { format(text) { return text; } };
`,
  'messages.ts': `// Offline source fixture: disconnected interface and event declarations.
export interface GreetingStrategyContract { greet(name: string): string; }
export const GreetingRequestedEvent = { type: 'greeting.requested' };
`,
});
const LIVE_FILE = 'graphlin-demo-live.mjs';
const LIVE_SOURCE = `// Offline source fixture, added only by an explicit demo trigger.
export function renderLiveGreetingPreview() { return LivePreviewBrowser.render(); }
export const LivePreviewBrowser = { render() { return 'offline preview'; } };
`;
const MARKER_FILE = '.graphlin-demo-fixture';
const MARKER = 'graphlin-offline-demo-v1\n';
export const DEMO_SESSION_ID = 'graphlin-offline-demo';

const RECORDED_ROLES = Object.freeze({
  saveNote: 'function', PostgreSQL: 'datastore',
  createNote: 'function', persistNote: 'function', NoteCache: 'datastore',
  WarmGreetingStrategy: 'class', EnthusiasticGreetingStrategy: 'class',
  BrowserNotesApplication: 'client', NotesApplicationService: 'service',
  NotificationDeliveryService: 'service', PendingNotificationsQueue: 'queue',
  ExternalGreetingProvider: 'external', GreetingRuntimeConfiguration: 'configuration',
  TextFormattingModule: 'module', GreetingToolkitPackage: 'package',
  GreetingStrategyContract: 'interface', GreetingRequestedEvent: 'event',
  renderLiveGreetingPreview: 'function', LivePreviewBrowser: 'client',
});
const RECORDED_RELATIONS = [
  ['saveNote', 'PostgreSQL', 'writes'],
  ['persistNote', 'NoteCache', 'writes'],
  ['createNote', 'persistNote', 'calls'],
  ['WarmGreetingStrategy', 'EnthusiasticGreetingStrategy', 'calls'],
  ['EnthusiasticGreetingStrategy', 'WarmGreetingStrategy', 'calls'],
  ['BrowserNotesApplication', 'NotesApplicationService', 'calls'],
  ['NotificationDeliveryService', 'PendingNotificationsQueue', 'calls'],
  ['NotificationDeliveryService', 'PendingNotificationsQueue', 'consumes'],
  ['NotificationDeliveryService', 'PendingNotificationsQueue', 'depends_on'],
  ['ExternalGreetingProvider', 'GreetingRuntimeConfiguration', 'depends_on'],
  ['TextFormattingModule', 'GreetingToolkitPackage', 'depends_on'],
  ['renderLiveGreetingPreview', 'LivePreviewBrowser', 'calls'],
].map(([sourceLabel, targetLabel, relation]) => ({ sourceLabel, targetLabel, relation, support: 0.97, missingContext: 0.02 }));

export function demoDecisionService() {
  // Explicit answers for this synthetic recording. Incidental labels are safe
  // but irrelevant, so they do not quarantine the shared synthetic snippet.
  // Unknown labels still receive the transport's conservative sensitivity=1.
  const incidental = { role: 'unknown', relevant: 0.01, sensitive: 0.01, support: 0.01 };
  return createDecisionService({
    fetchImpl: createFixtureTransport({ mode: 'demo', candidates: {
      ...Object.fromEntries(Object.entries(RECORDED_ROLES).map(([label, role]) =>
        [label, { role, relevant: 0.98, sensitive: 0.01, support: 0.97 }])),
      path: incidental, database: incidental, note: incidental,
      INSERT: incidental, INTO: incidental, VALUES: incidental,
    }, relations: RECORDED_RELATIONS }),
    materializeBundle, buildRelationProposals,
  });
}

async function writeFixture(projectRoot, name, content) {
  const file = await open(path.join(projectRoot, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(content); } finally { await file.close(); }
}

async function verifyDemoProject(projectRoot) {
  const resolved = path.resolve(projectRoot);
  if (await canonicalProjectRoot(resolved) !== resolved) throw runtimeError('invalid_demo_directory');
  const file = await open(path.join(resolved, MARKER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size !== Buffer.byteLength(MARKER) || await file.readFile('utf8') !== MARKER) {
      throw runtimeError('invalid_demo_directory');
    }
  } finally { await file.close(); }
  return resolved;
}

export async function createDemoProject(dataDir = defaultDataDir()) {
  const base = await privateDirectory(path.resolve(dataDir));
  const project = await privateDirectory(path.join(base, 'demo-project'));
  // Never let an enclosing real checkout become the demo's project scope.
  if (await canonicalProjectRoot(project) !== project) throw runtimeError('invalid_demo_directory');
  for (const [name, content] of Object.entries(FIXTURES)) await writeFixture(project, name, content);
  await writeFixture(project, MARKER_FILE, MARKER);
  await unlink(path.join(project, LIVE_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return project;
}

export async function replayDemo(pipeline, projectRoot) {
  await verifyDemoProject(projectRoot);
  const event = async (hook_event_name, extra = {}) => {
    await pipeline.ingest({ hook_event_name, cwd: projectRoot, session_id: DEMO_SESSION_ID, ...extra }, { host: 'claude' });
    await pipeline.whenIdle();
  };
  await event('UserPromptSubmit', { prompt: 'Explore the offline architecture fixture. No code is executed and no runtime connection is verified.' });
  await event('SessionStart');
  // Explicit observations after discovery give every small artifact its own
  // complete candidate/proposal budget. No graph or decision is patched here.
  for (const name of Object.keys(FIXTURES)) {
    const tool = { tool_name: 'Read', tool_use_id: `demo-read-${randomUUID()}`,
      tool_input: { file_path: path.join(projectRoot, name) } };
    await event('PreToolUse', tool);
    await event('PostToolUse', { ...tool, tool_response: { success: true } });
  }
  await event('Stop', { last_assistant_message: 'Offline source fixtures are captured. Runtime connectivity has not been verified.' });
  return pipeline.getState();
}

/**
 * Explicit, timer-free live demo trigger. Returns an ordinary existing IPC
 * capture message after changing one owned fixture file. A parent process may
 * send it with requestIPC(socket, message); no new HTTP/control route is needed.
 */
export async function prepareDemoChange(projectRoot, { action } = {}) {
  if (!['add', 'remove'].includes(action)) throw runtimeError('invalid_demo_action');
  const root = await verifyDemoProject(projectRoot);
  if (action === 'add') await writeFixture(root, LIVE_FILE, LIVE_SOURCE);
  else await unlink(path.join(root, LIVE_FILE)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return {
    host: 'claude',
    payload: {
      hook_event_name: 'PostToolUse', cwd: root, session_id: DEMO_SESSION_ID,
      tool_name: action === 'add' ? 'Write' : 'apply_patch',
      tool_use_id: `demo-${action}-${randomUUID()}`,
      tool_input: { file_path: path.join(root, LIVE_FILE) },
      tool_response: { success: true },
    },
  };
}

export async function replayDemoChange(pipeline, projectRoot, options) {
  if (pipeline.getState().mode !== 'demo') throw runtimeError('demo_mode_required');
  const { host, payload } = await prepareDemoChange(projectRoot, options);
  await pipeline.ingest(payload, { host });
  await pipeline.whenIdle();
  return pipeline.getState();
}
