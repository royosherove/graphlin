/** Graphlin extension API 1; model schema and scene schema are independent. */
export type Identifier = string;
export type Basis = 'metadata' | 'parsed' | 'lexical' | 'decision' | 'legacy'
  | 'documentation' | 'annotation' | 'runtime';
export type Validity = 'current' | 'stale' | 'retracted';
export type Classification = 'accepted' | 'tentative' | 'unknown' | 'stale' | 'pending' | 'abstained';
export interface SourceReference {
  artifactId?: Identifier;
  eventId?: Identifier;
  hash?: string;
  generation?: number;
  startLine?: number;
  endLine?: number;
  sourceClass?: 'source' | 'public_intent' | 'runtime';
}
export interface Entity {
  id: Identifier;
  label: string;
  kind: string;
  parentId: Identifier | null;
  artifactId?: Identifier;
  qualifiedName?: string;
  sourceRefs: SourceReference[];
  basis: Basis;
  validity: Validity;
  classification: Classification;
}
export interface Relation {
  id: Identifier;
  source: Identifier;
  target: Identifier;
  kind: string;
  basis: Basis;
  validity: Validity;
  sourceRefs: SourceReference[];
}
export interface Interpretation {
  id: Identifier;
  namespace: string;
  version: string;
  kind: string;
  label: string;
  entityIds: Identifier[];
  basis: Basis;
  validity: Validity;
  classification: Classification;
  support: 'supported' | 'tentative' | 'unknown' | 'contradicted';
  sourceRefs: SourceReference[];
}
export interface Activity {
  id: Identifier;
  kind: string;
  sequence: number;
  knownAtSequence: number;
  at: string;
  recordedAt: string;
  sessionId?: Identifier;
  agentId?: Identifier;
  toolCallId?: Identifier;
  toolCategory?: 'read' | 'write' | 'edit' | 'shell' | 'search' | 'test' | 'other';
  /** Observable file activity, independent of a successful source modification. */
  operation?: 'read' | 'edit';
  /** Exact file targets or additional decision-selected source blocks. */
  mapping?: 'exact' | 'decision';
  outcome?: 'pending' | 'succeeded' | 'failed' | 'interrupted' | 'denied' | 'unresolved' | 'observed';
  attribution?: 'observed' | 'correlated' | 'unknown';
  creation?: boolean;
  entityIds: Identifier[];
  artifactIds: Identifier[];
  sourceRefs: SourceReference[];
}
export interface CoverageCounts {
  total?: number;
  inventoried?: number;
  inspected?: number;
  parsed?: number;
  deferred?: number;
  excluded?: number;
  unsupported?: number;
  unavailable?: number;
  truncated?: number;
  retained?: number;
  files?: number;
  entities?: number;
  relations?: number;
}
export interface Coverage extends CoverageCounts {
  complete?: boolean;
  status?: string;
  counts?: CoverageCounts;
  scopes?: (CoverageCounts & { id: Identifier; label: string; entityId?: Identifier; parentId?: Identifier; status?: string })[];
}
export interface Session {
  id: Identifier;
  host?: 'claude' | 'codex' | 'kiro' | 'demo' | 'unknown';
  startedAt?: string;
  endedAt?: string;
  status?: string;
}
export interface Checkpoint {
  id: Identifier;
  revision?: number;
  sequence?: number;
  at?: string;
  createdAt?: string;
  label: string;
}
export interface ModelSnapshot {
  schemaVersion: 2;
  projectId: Identifier;
  revision: number;
  sequence: number;
  entities: Entity[];
  relations: Relation[];
  interpretations: Interpretation[];
  activity: Activity[];
  coverage: Coverage;
  sessions: Session[];
  checkpoints: Checkpoint[];
}
export type SceneKind = 'client' | 'service' | 'datastore' | 'queue' | 'external' | 'module'
  | 'function' | 'class' | 'interface' | 'event' | 'configuration' | 'package' | 'group' | 'unknown';
export type SceneStyle = 'default' | 'muted' | 'selected' | 'active' | 'pending' | 'failed'
  | 'stale' | 'tentative' | 'added' | 'modified' | 'removed' | 'discovered' | 'unknown';
export type SceneShape = 'rounded_rect' | 'rect' | 'cylinder' | 'cloud' | 'diamond' | 'group'
  | 'hexagon' | 'class_box' | 'interface_box' | 'document' | 'parallelogram' | 'folder' | 'browser' | 'component' | 'queue';
export type EdgeKind = 'calls' | 'reads' | 'writes' | 'publishes' | 'consumes' | 'depends_on'
  | 'contains' | 'imports' | 'references' | 'member_of' | 'hosted_by' | 'unknown';
export interface SceneBox {
  id: Identifier;
  label: string;
  parentId?: Identifier | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  style?: SceneStyle;
  shape?: SceneShape;
  collapsed?: boolean;
}
export interface SceneNode extends SceneBox { entityId: Identifier; kind: SceneKind }
export interface SceneGroup extends SceneBox { entityIds: Identifier[]; kind?: SceneKind; membershipId?: Identifier }
export interface SceneEdge {
  id: Identifier;
  source: Identifier;
  target: Identifier;
  kind: EdgeKind;
  relationIds?: Identifier[];
  label?: string;
  count?: number;
  style?: SceneStyle;
}
export interface Scene {
  sceneVersion: 1;
  nodes: SceneNode[];
  groups: SceneGroup[];
  edges: SceneEdge[];
  coverage?: { shown?: number; total?: number; truncated?: boolean; label?: string };
}
export type C4InterpretationKind = 'application' | 'container' | 'component' | 'system'
  | 'external_system' | 'actor' | 'person' | 'context' | 'datastore';
type FixedInterpretation =
  | { interpretationKind?: undefined; interpretationLabel?: undefined }
  | { interpretationKind: C4InterpretationKind; interpretationLabel?: string };
/** Optional mappings apply only to supported, accepted answers with current
 * source references. Labels are at most 80 characters; the core filters them.
 * Without a label, the broker uses the first selected entity's core label. */
export type DecisionQuestion = { id: string; question: string } & (
  | (({ kind: 'boolean' | 'score'; options?: never }
    | { kind: 'choice'; options: string[] }) & FixedInterpretation)
  | { kind: 'choice'; options: (C4InterpretationKind | 'unknown')[];
      interpretationKind: 'selected-choice'; interpretationLabel?: string }
);
export interface DecisionProfile {
  id: string;
  questions: DecisionQuestion[];
  selectors: { fields: ('entities' | 'relations' | 'interpretations')[]; candidateIds: Identifier[] };
}
export interface MessageContext {
  apiVersion: 1;
  instanceId: Identifier;
  projectId: Identifier;
  revision: number;
  viewEpoch: number;
  requestId: Identifier;
}
export type ExtensionMessage =
  | (MessageContext & { type: 'graphlin:project'; model: ModelSnapshot; settings?: Record<string, unknown>; selection?: Identifier | null })
  | (MessageContext & { type: 'graphlin:scene'; scene: Scene })
  | (MessageContext & { type: 'graphlin:dispose' })
  | (MessageContext & { type: 'graphlin:error'; code: string })
  | (MessageContext & { type: 'graphlin:status'; status: 'ready' | 'busy' | 'empty' | 'error'; itemCount: number })
  | (MessageContext & { type: 'graphlin:select'; selection:
      { entityId: Identifier } | { relationId: Identifier } | { activityId: Identifier } });
export function validateScene(scene: unknown, options?: { model?: ModelSnapshot }): Scene;
export function validateDecisionProfile(profile: unknown): DecisionProfile;
export function validateMessage(message: unknown, options?: { model?: ModelSnapshot; context?: MessageContext }): ExtensionMessage;
export function connectExtension(options: {
  project?: (model: ModelSnapshot, settings: Record<string, unknown>, selection: Identifier | null) => Scene | void | Promise<Scene | void>;
  mount?: (context: { root: HTMLElement | null; assets: Record<string, unknown> }) => void;
  dispose?: () => void;
}): () => void;
export const API_VERSION: 1;
export const MODEL_SCHEMA: 2;
export const SCENE_VERSION: 1;
export const SCENE_KINDS: readonly SceneKind[];
export const SCENE_SHAPES: readonly SceneShape[];
export const EDGE_KINDS: readonly EdgeKind[];
export const EXTENSION_LIMITS: Readonly<Record<string, number>>;
