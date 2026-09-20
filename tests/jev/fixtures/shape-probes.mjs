// Synthetic review expectations, not recorded model results. Importing performs
// no I/O, and none of these source strings are executed. Live runs use real
// capture, intake, classification, and compilation through evaluate-jev.mjs.
export const shapeProbes = [
  {
    id: 'kind-function', expectation: 'kinds',
    expected: { nodes: [{ name: 'handleRequest', role: 'function' }] },
    source: `export function handleRequest(request) {
  return { status: 200, body: request.body };
}`,
  },
  {
    id: 'kind-arrow', expectation: 'kinds',
    expected: { nodes: [{ name: 'renderClient', role: 'function' }] },
    source: `export const renderClient = (name) => {
  return { greeting: name };
};`,
  },
  {
    id: 'kind-class', expectation: 'kinds',
    expected: { nodes: [{ name: 'NotesService', role: 'class' }] },
    source: `export class NotesService {
  format(note) { return { body: note.body }; }
}`,
  },
  {
    id: 'kind-interface', expectation: 'kinds', filename: 'shape-test.ts',
    expected: { nodes: [{ name: 'NoteCreatedEvent', role: 'interface' }] },
    source: `export interface NoteCreatedEvent {
  type: "note.created";
  noteId: string;
}`,
  },
  {
    id: 'kind-type-alias', expectation: 'kinds', filename: 'shape-test.ts',
    expected: { nodes: [{ name: 'NoteId', role: 'module' }] },
    source: 'export type NoteId = string;',
  },
  {
    id: 'kind-event', expectation: 'kinds',
    expected: { nodes: [{ name: 'noteCreated', role: 'event' }] },
    source: `export const noteCreated = new CustomEvent("note.created", {
  detail: { noteId: "example-note" }
});`,
  },
  {
    id: 'kind-configuration', expectation: 'kinds',
    expected: { nodes: [
      { name: 'poolOptions', role: 'configuration' },
      { name: 'db', role: 'datastore' },
    ] },
    source: `import { Pool } from "pg";
export const poolOptions = { connectionString: process.env.DATABASE_URL, max: 5 };
export const db = new Pool(poolOptions);`,
  },
  {
    id: 'kind-package-alias', expectation: 'kinds',
    expected: { nodes: [{ name: 'database', role: 'package' }] },
    source: `import * as database from "pg";
export { database };`,
  },
  {
    id: 'kind-member-alias', expectation: 'kinds',
    expected: { nodes: [{ name: 'Store', role: 'module' }] },
    source: `import { Pool as Store } from "pg";
export { Store };`,
  },
  {
    id: 'kind-plain-data', expectation: 'kinds',
    expected: { nodes: [{ name: 'event', role: 'module' }] },
    source: 'export const event = { count: 1, amount: 20 };',
  },
];
