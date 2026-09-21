import {
  GENERIC_LABELS, LIMITS, RELATIONS, clone, equal, exactKeys, freeze, hash, integer, isHash, isId, opaque, plain, probability,
} from './common.mjs';
import { createPolicy, excluded, safeLabel, safeText } from './privacy.mjs';
import { lexicalHints } from './lexical.mjs';

const FIELDS = ['id', 'artifactId', 'hash', 'generation', 'label', 'text', 'startLine', 'endLine',
  'sourceClass', 'complete', 'entityKey', 'labelOrigin', 'sourceRef', 'digest'];
const approvedBundles = new WeakSet();

export function validSourceRef(ref) {
  if (ref?.type === 'artifact') return exactKeys(ref, ['type', 'artifactId', 'hash', 'generation']) &&
    isId(ref.artifactId) && isHash(ref.hash) && integer(ref.generation, 1);
  return ref?.type === 'message' && exactKeys(ref, ['type', 'messageId', 'hash', 'contentVersion']) &&
    isId(ref.messageId) && isHash(ref.hash) && integer(ref.contentVersion, 1);
}

function digestFields(candidate) {
  // Explicit field order makes digests independent of JSON object key order.
  return {
    artifactId: candidate.artifactId, hash: candidate.hash, generation: candidate.generation,
    label: candidate.label, text: candidate.text, startLine: candidate.startLine, endLine: candidate.endLine,
    sourceClass: candidate.sourceClass, complete: candidate.complete, entityKey: candidate.entityKey,
    labelOrigin: candidate.labelOrigin, sourceRef: candidate.sourceRef,
  };
}
const candidateDigest = (candidate, policy) => hash([policy.version, digestFields(candidate)]);

export function validCandidate(candidate, policy) {
  if (!policy.transmitSource || !exactKeys(candidate, FIELDS) || !isId(candidate.id) ||
      !isId(candidate.artifactId) || !isId(candidate.entityKey) || !isHash(candidate.hash) ||
      !isHash(candidate.digest) || !integer(candidate.generation, 1) ||
      !integer(candidate.startLine, 1, 10000000) || !integer(candidate.endLine, candidate.startLine, 10000000) ||
      candidate.endLine - candidate.startLine >= LIMITS.snippetLines ||
      !safeLabel(candidate.label) || !safeText(candidate.text) || typeof candidate.complete !== 'boolean' ||
      !validSourceRef(candidate.sourceRef)) return false;
  const ref = candidate.sourceRef;
  if (candidate.hash !== ref.hash || candidate.generation !== (ref.generation ?? ref.contentVersion) ||
      candidate.artifactId !== (ref.artifactId ?? ref.messageId) ||
      candidate.sourceClass !== (ref.type === 'artifact' ? 'source' : 'public_intent')) return false;
  const lines = candidate.text.split('\n');
  if (lines.length !== candidate.endLine - candidate.startLine + 1) return false;
  const origin = candidate.labelOrigin;
  if (origin?.type === 'span') {
    if (!exactKeys(origin, ['type', 'startLine', 'endLine', 'startColumn', 'endColumn']) ||
        !integer(origin.startLine, candidate.startLine, candidate.endLine) || origin.endLine !== origin.startLine ||
        !integer(origin.startColumn, 1, LIMITS.snippetChars) ||
        !integer(origin.endColumn, origin.startColumn, LIMITS.snippetChars + 1) ||
        lines[origin.startLine - candidate.startLine]?.slice(origin.startColumn - 1, origin.endColumn - 1) !== candidate.label) return false;
  } else if (!exactKeys(origin, ['type', 'label']) || origin.type !== 'generic' ||
      origin.label !== candidate.label || !GENERIC_LABELS.includes(candidate.label)) return false;
  return candidate.digest === candidateDigest(candidate, policy) && candidate.id === opaque('candidate', candidate.digest);
}

function snippets(text, coverage) {
  const lines = text.split('\n'), result = [];
  let current = [], startLine = 1, chars = 0, offset = 0, startOffset = 0;
  function emit() {
    if (current.length && current.some(line => line.trim())) result.push({ text: current.join('\n'), startLine, endLine: startLine + current.length - 1, offset: startOffset });
    current = []; chars = 0;
  }
  let i = 0;
  for (; i < lines.length && result.length < LIMITS.candidates; i++) {
    const line = lines[i];
    if (line.length > LIMITS.snippetChars) {
      coverage.truncated = true;
      emit(); startLine = i + 2; offset += line.length + 1; continue;
    }
    if (current.length >= LIMITS.snippetLines || chars + line.length + (current.length ? 1 : 0) > LIMITS.snippetChars) {
      emit(); startLine = i + 1;
    }
    if (!current.length) { startLine = i + 1; startOffset = offset; }
    chars += line.length + (current.length ? 1 : 0);
    current.push(line);
    offset += line.length + 1;
  }
  if (result.length < LIMITS.candidates) emit();
  else if (current.length || i < lines.length) coverage.truncated = true;
  return result;
}

function entities(snippet, hints, available) {
  const found = [];
  for (const hint of hints.entities) {
    const { label } = hint, offset = hint.start - snippet.offset;
    if (offset < 0 || hint.end > snippet.offset + snippet.text.length || !safeLabel(label)) continue;
    available.add(`span:${label}`);
    if (found.length >= LIMITS.candidates) continue;
    const before = snippet.text.slice(0, offset), lineOffset = before.split('\n').length - 1;
    const column = offset - before.lastIndexOf('\n');
    found.push({
      label, labelOrigin: { type: 'span', startLine: snippet.startLine + lineOffset, endLine: snippet.startLine + lineOffset,
        startColumn: column, endColumn: column + label.length },
    });
  }
  if (!found.length) available.add('generic:Module');
  return found.length ? found : [{ label: 'Module', labelOrigin: { type: 'generic', label: 'Module' } }];
}

function candidatesFor(source, policy, coverage = {}) {
  const selections = [], seen = new Set();
  const available = new Set();
  const hints = lexicalHints(source.text);
  const ranks = new Map(hints.entities.map(hint => [hint.label, hint.rank]));
  for (const selection of snippets(source.text, coverage)) {
    const { offset, ...snippet } = selection;
    if (!safeText(snippet.text)) continue;
    for (const entity of entities(selection, hints, available)) {
      // Same exact identifier in a file is one lexical entity, not a claim
      // about language-level scoping. Different files always have distinct IDs.
      const entityKey = opaque('entity', source.id, entity.labelOrigin.type, entity.label);
      if (seen.has(entityKey)) continue;
      seen.add(entityKey);
      selections.push({ entity, snippet, entityKey, rank: ranks.get(entity.label) ?? 5 });
    }
  }
  coverage.available = available.size;
  return selections.sort((a, b) => a.rank - b.rank || a.snippet.startLine - b.snippet.startLine)
    .slice(0, LIMITS.candidates).map(({ entity, snippet, entityKey }) => {
      const fields = {
        artifactId: source.id, hash: source.hash, generation: source.generation,
        ...entity, ...snippet, sourceClass: source.sourceClass, complete: source.complete,
        entityKey, sourceRef: source.sourceRef,
      };
      const digest = candidateDigest(fields, policy);
      return freeze({ id: opaque('candidate', digest), ...fields, digest });
    });
}

export function buildCandidates({ event, artifacts = [], publicText = null, policy, onDiagnostic } = {}) {
  policy = createPolicy(policy);
  const report = value => {
    try {
      const pending = onDiagnostic?.(freeze(value));
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch { /* Diagnostics never affect extraction. */ }
  };
  if (!policy.transmitSource || !plain(event) || !isId(event.id) ||
      ['tool.requested', 'capture.gap'].includes(event.kind)) {
    report({ reason: !policy.transmitSource ? 'metadata_only' : 'event_not_classifiable', selected: 0 });
    return [];
  }
  const groups = [];
  const observations = [];
  if (Array.isArray(artifacts)) for (const artifact of artifacts.slice(0, LIMITS.paths)) {
    const observation = { artifactId: artifact?.id, available: 0, selected: 0, reason: 'no_candidates' };
    observations.push(observation);
    if (artifact?.status !== 'present' || artifact.exists !== true || artifact.complete !== true ||
        !isId(artifact.id) || !isHash(artifact.hash) || !integer(artifact.generation, 1) ||
        excluded(artifact.relativePath, policy) || !safeText(artifact.text, LIMITS.fileBytes)) {
      observation.reason = excluded(artifact?.relativePath, policy) ? 'excluded_path'
        : artifact?.status === 'missing' ? 'file_missing'
        : artifact?.status === 'partial' || artifact?.complete === false ? 'incomplete_artifact'
        : artifact?.status !== 'present' ? 'artifact_unavailable'
        : typeof artifact.text !== 'string' ? 'source_withheld'
        : !artifact.text.trim() ? 'empty_source' : 'source_not_safe';
      continue;
    }
    const group = candidatesFor({
      ...artifact, sourceClass: 'source', sourceRef: {
        type: 'artifact', artifactId: artifact.id, hash: artifact.hash, generation: artifact.generation,
      },
    }, policy, observation);
    groups.push(group);
  }
  if (['turn.prompted', 'intent.observed'].includes(event.kind) && safeText(publicText, LIMITS.snippetChars * 4)) {
    const contentVersion = integer(event.sequence, 1) ? event.sequence : 1;
    const digest = hash(publicText);
    groups.push(candidatesFor({
      id: event.id, text: publicText, hash: digest, generation: contentVersion,
      complete: event.incomplete === false, sourceClass: 'public_intent',
      sourceRef: { type: 'message', messageId: event.id, hash: digest, contentVersion },
    }, policy));
  }
  const result = [];
  for (let offset = 0; offset < LIMITS.candidates && result.length < LIMITS.candidates; offset++) {
    for (const group of groups) if (group[offset] && result.length < LIMITS.candidates) result.push(group[offset]);
  }
  for (const observation of observations) {
    observation.selected = result.filter(candidate => candidate.artifactId === observation.artifactId).length;
    if (observation.truncated) observation.reason = 'snippet_limit';
    else if (observation.available) observation.reason = observation.selected < observation.available ? 'candidate_limit' : 'candidates_ready';
    report(observation);
  }
  if (Array.isArray(artifacts) && artifacts.length > LIMITS.paths) report({
    reason: 'artifact_limit', available: artifacts.length, selected: LIMITS.paths,
  });
  return freeze(result);
}

/**
 * Module context for source architecture, independent of lexical entity ranking.
 * Keep separate, exact line spans: two opening fragments and ten closing ones
 * when the file exceeds the existing candidate budget. Oversized lines and
 * locally withheld or blank fragments count as omissions; they are never
 * concatenated. JSON/UTF-8 bytes share the character budget to bound A/B wire size.
 */
export function buildModuleCandidates({ event, artifact, policy } = {}) {
  policy = createPolicy(policy);
  if (!policy.transmitSource || !plain(event) || !isId(event.id) ||
      ['tool.requested', 'capture.gap'].includes(event.kind) ||
      artifact?.status !== 'present' || artifact.exists !== true || artifact.complete !== true ||
      !isId(artifact.id) || !isHash(artifact.hash) || !integer(artifact.generation, 1) ||
      excluded(artifact.relativePath, policy) || !safeText(artifact.text, LIMITS.fileBytes) ||
      Buffer.byteLength(artifact.text) > LIMITS.fileBytes || hash(artifact.text) !== artifact.hash) {
    return freeze({ candidates: [], omitted: 0 });
  }
  const head = [], tail = [], lines = artifact.text.split('\n');
  let current = [], startLine = 1, chars = 0, encodedBytes = 2, available = 0, omitted = 0;
  function emit() {
    const text = current.join('\n');
    if (text.trim()) {
      if (!safeText(text)) omitted++;
      else {
        const fragment = { text, startLine, endLine: startLine + current.length - 1 };
        available++;
        if (head.length < 2) head.push(fragment);
        else {
          tail.push(fragment);
          if (tail.length > LIMITS.candidates - 2) tail.shift();
        }
      }
    } else if (current.length) omitted++; // Blank spans must not displace executable context.
    current = []; chars = 0; encodedBytes = 2;
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(JSON.stringify(line)) - 2;
    if (line.length > LIMITS.snippetChars || lineBytes + 2 > LIMITS.snippetChars) {
      emit(); omitted++; continue;
    }
    // Keep a final newline with its preceding line instead of silently losing
    // it as an empty fragment after a full 24-line or 1800-character window.
    const finalNewline = Number(index === lines.length - 2 && lines[index + 1] === '');
    if (current.length + 1 + finalNewline > LIMITS.snippetLines ||
        chars + line.length + (current.length ? 1 : 0) + finalNewline > LIMITS.snippetChars ||
        encodedBytes + lineBytes + (current.length ? 2 : 0) + finalNewline * 2 > LIMITS.snippetChars) emit();
    if (!current.length) startLine = index + 1;
    chars += line.length + (current.length ? 1 : 0);
    encodedBytes += lineBytes + (current.length ? 2 : 0);
    current.push(line);
  }
  emit();
  const fragments = [...head, ...tail];
  omitted += available - fragments.length;
  const sourceRef = { type: 'artifact', artifactId: artifact.id, hash: artifact.hash, generation: artifact.generation };
  const candidates = fragments.map(fragment => {
    const fields = {
      artifactId: artifact.id, hash: artifact.hash, generation: artifact.generation,
      label: 'Module', labelOrigin: { type: 'generic', label: 'Module' }, ...fragment,
      sourceClass: 'source', complete: omitted === 0,
      entityKey: opaque('entity', artifact.id, 'module-context', fragment.startLine, fragment.endLine), sourceRef,
    };
    const digest = candidateDigest(fields, policy);
    return { id: opaque('candidate', digest), ...fields, digest };
  });
  return freeze({ candidates, omitted });
}

function readSet(candidates) {
  const refs = new Map();
  for (const candidate of candidates) {
    const ref = candidate.sourceRef.type === 'message' ? candidate.sourceRef :
      { artifactId: candidate.artifactId, hash: candidate.hash, generation: candidate.generation };
    refs.set(JSON.stringify(ref), clone(ref));
  }
  return [...refs.values()];
}
const bundleId = (policyVersion, candidates, refs) => opaque('bundle', policyVersion, candidates.map(c => c.digest), refs);

export function materializeBundle({ candidates = [], verdicts = [], policy, intakePolicy = {} } = {}) {
  policy = createPolicy(policy);
  const sensitiveMax = intakePolicy?.sensitiveMax ?? 0.1, relevantMin = intakePolicy?.relevantMin ?? 0.5;
  let approved = [];
  const counts = new Map(), judgments = new Map(), versions = new Map(), quarantined = [];
  // Overflow is rejected wholesale; trimming before duplicate detection would
  // let a conflicting verdict placed beyond the limit approve content.
  if (Array.isArray(candidates) && candidates.length <= LIMITS.candidates && Array.isArray(verdicts) &&
      verdicts.length <= LIMITS.candidates && probability(sensitiveMax) && probability(relevantMin)) {
    for (const c of candidates) {
      counts.set(c?.id, (counts.get(c?.id) ?? 0) + 1);
      if (c?.artifactId) {
        const key = `${c.hash}:${c.generation}`;
        const previous = versions.get(c.artifactId);
        versions.set(c.artifactId, previous === undefined || previous === key ? key : null);
      }
    }
    for (const v of verdicts) {
      if (judgments.has(v?.candidateId)) judgments.set(v?.candidateId, null);
      else judgments.set(v?.candidateId, v);
    }
    for (const c of candidates) {
      const v = judgments.get(c?.id);
      const sensitivityApproved = counts.get(c?.id) === 1 && versions.get(c?.artifactId) !== null && validCandidate(c, policy) &&
        exactKeys(v, ['candidateId', 'digest', 'relevant', 'sensitive']) && v.digest === c.digest &&
        probability(v.sensitive) && probability(v.relevant) && v.sensitive <= sensitiveMax;
      if (!sensitivityApproved) { if (plain(c)) quarantined.push(c); continue; }
      if (v.relevant < relevantMin) continue;
      approved.push(clone(c));
    }
    // One snippet may describe several entities. A conflicting/missing safety
    // answer quarantines its copied context, not just one candidate's title.
    approved = approved.filter(c => !quarantined.some(blocked =>
      c.text === blocked.text || c.artifactId === blocked.artifactId &&
      c.startLine <= blocked.endLine && blocked.startLine <= c.endLine));
  }
  const refs = readSet(approved);
  const bundle = freeze({ id: bundleId(policy.version, approved, refs), policyVersion: policy.version, candidates: approved, readSet: refs });
  approvedBundles.add(bundle);
  return bundle;
}

export function validBundle(bundle, policy) {
  if (!approvedBundles.has(bundle) || !exactKeys(bundle, ['id', 'policyVersion', 'candidates', 'readSet']) || bundle.policyVersion !== policy.version ||
      !Array.isArray(bundle.candidates) || bundle.candidates.length > LIMITS.candidates ||
      !Array.isArray(bundle.readSet) || bundle.readSet.length > LIMITS.candidates ||
      bundle.candidates.some(c => !validCandidate(c, policy))) return false;
  if (new Set(bundle.candidates.map(c => c.id)).size !== bundle.candidates.length) return false;
  const refs = readSet(bundle.candidates);
  return equal(refs, bundle.readSet) && bundle.id === bundleId(policy.version, bundle.candidates, refs);
}

export function proposalId(bundle, source, target, relation, evidence) {
  return opaque('proposal', bundle.id, source, target, relation, evidence);
}
export function buildRelationProposals(bundle, limits = {}) {
  const candidates = Array.isArray(bundle?.candidates) ? bundle.candidates : [];
  if (!approvedBundles.has(bundle) || candidates.length > LIMITS.candidates || !isId(bundle?.id) ||
      new Set(candidates.map(c => c.id)).size !== candidates.length || candidates.some(c => !isId(c.id))) return { proposals: [], omitted: 0 };
  const requested = [limits.maxProposals, limits.maxRelationProposals].filter(n => integer(n, 0));
  const questionLimit = integer(limits.maxQuestionsPerStage, 0, 1000) ? limits.maxQuestionsPerStage : 40;
  const maximum = Math.min(LIMITS.proposals, ...requested, Math.max(0, Math.floor((questionLimit - 1 - 2 * candidates.length) / 2)));
  const pairs = [], hints = new Map(), analyses = new Map();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.artifactId, candidate.hash, candidate.generation, candidate.startLine, candidate.text]);
    if (analyses.has(key)) continue;
    const analysis = lexicalHints(candidate.text);
    analyses.set(key, analysis);
    for (const hint of analysis.pairs) {
      const pairKey = JSON.stringify([candidate.artifactId, candidate.hash, candidate.generation, hint.source, hint.target]);
      const prior = hints.get(pairKey);
      if (!prior || prior.rank > hint.rank) hints.set(pairKey, hint);
    }
  }
  for (const source of candidates) for (const target of candidates) {
    if (source.id === target.id || source.entityKey === target.entityKey) continue;
    const colocated = source.artifactId === target.artifactId && source.hash === target.hash && source.generation === target.generation;
    const hint = colocated ? hints.get(JSON.stringify([source.artifactId, source.hash, source.generation, source.label, target.label])) : null;
    pairs.push({ source, target, rank: hint?.rank ?? (colocated ? 10 : 20), offset: hint?.offset ?? 0, kind: hint?.kind });
  }
  pairs.sort((a, b) => a.rank - b.rank || a.offset - b.offset);
  const proposals = [];
  // Exhaust the six independent relation questions for the best lexical pair
  // before fanout. A binding/constructor pair prioritizes the dependency
  // question in a remaining slot; this is selection, never semantic evidence.
  for (const { source, target, kind } of pairs) {
    const relations = kind === 'binding' ? ['depends_on', ...RELATIONS.filter(r => r !== 'depends_on')] : RELATIONS;
    for (const relation of relations) {
      if (proposals.length >= maximum) break;
      const evidenceCandidateIds = [source.id, target.id];
      proposals.push({
        id: proposalId(bundle, source.id, target.id, relation, evidenceCandidateIds),
        sourceCandidateId: source.id, targetCandidateId: target.id, relation, evidenceCandidateIds,
      });
    }
    if (proposals.length >= maximum) break;
  }
  return freeze({ proposals, omitted: pairs.length * RELATIONS.length - proposals.length });
}
