import { ROLES, RELATIONS, ACTIVITIES } from './questions.mjs';
import { JevFault, isProbability, isRecord } from './wire.mjs';

export const FIXTURE_TRANSPORT = Symbol.for('graphlin.jev.recorded-fixture');

const recordedCandidates = Object.freeze({
  'Notes API': { role: 'service', relevant: 0.98, sensitive: 0.01, support: 0.97 },
  'Notes repository': { role: 'module', relevant: 0.98, sensitive: 0.01, support: 0.97 },
  saveNote: { role: 'function', relevant: 0.98, sensitive: 0.01, support: 0.97 },
  PostgreSQL: { role: 'datastore', relevant: 0.98, sensitive: 0.01, support: 0.97 },
});
const recordedRelations = Object.freeze([
  { sourceLabel: 'Notes API', targetLabel: 'Notes repository', relation: 'calls',
    support: 0.97, missingContext: 0.02 },
  { sourceLabel: 'Notes repository', targetLabel: 'PostgreSQL', relation: 'writes',
    support: 0.97, missingContext: 0.02 },
  { sourceLabel: 'saveNote', targetLabel: 'PostgreSQL', relation: 'writes',
    support: 0.97, missingContext: 0.02 },
]);

/**
 * An OFFLINE DEMO recording lookup, never a source-code classifier.
 * Explicit mode:"demo" is required. Unknown labels are withheld. Source text is
 * never interpreted and this function never delegates to fetch or opens a socket.
 */
export function createFixtureTransport({
  mode,
  candidates = recordedCandidates,
  relations = recordedRelations,
  activity = 'implement',
  relevance = 0.98,
} = {}) {
  if (mode !== 'demo') throw new JevFault('fixture_requires_demo_mode');
  if (!isRecord(candidates) || !Array.isArray(relations)
    || !ACTIVITIES.includes(activity) || !isProbability(relevance)) {
    throw new JevFault('invalid_fixture');
  }
  const candidateRecords = structuredClone(candidates);
  const relationRecords = structuredClone(relations);
  for (const record of Object.values(candidateRecords)) {
    if (!isRecord(record) || !ROLES.includes(record.role)
      || !['relevant', 'sensitive', 'support'].every((key) => isProbability(record[key]))) {
      throw new JevFault('invalid_fixture');
    }
  }
  for (const record of relationRecords) {
    if (!isRecord(record) || typeof record.sourceLabel !== 'string'
      || typeof record.targetLabel !== 'string' || !RELATIONS.includes(record.relation)
      || !isProbability(record.support) || !isProbability(record.missingContext)) {
      throw new JevFault('invalid_fixture');
    }
  }
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    const { entities } = request.state;
    const recordFor = entity => entity && Object.hasOwn(candidateRecords, entity.name)
      ? candidateRecords[entity.name]
      : { role: 'unknown', relevant: 0.01, sensitive: 1, support: 0.01 };
    const answers = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const index = Number(id.slice(id.lastIndexOf('_') + 1));
      const record = recordFor(entities[index]);
      if (question.type === 'choice') {
        const choice = id === 'a_activity' ? activity : record.role;
        answers[id] = {
          type: 'choice', choice, confidence: 0.98,
          probabilities: Object.fromEntries(Object.keys(question.criteria)
            .map((key) => [key, key === choice ? 1 : 0])),
        };
      } else if (question.type === 'noul') {
        let noul;
        if (id.startsWith('a_sensitive_')) {
          // A shared snippet has one safety verdict. Conflicting/unknown demo
          // records withhold the whole snippet; they never certify its contents.
          const members = entities.filter(entity => entity.sourceIndex === index);
          noul = members.length ? Math.max(...members.map(entity => recordFor(entity).sensitive)) : 1;
        }
        else if (id.startsWith('a_relevant_')) noul = record.relevant;
        else if (id === 'b_relevance') noul = relevance;
        else if (id.startsWith('b_support_')) noul = record.support;
        else if (id.startsWith('b_relation_') || id.startsWith('b_context_')) {
          const target = request.state.proposals[index];
          const relation = relationRecords.find((entry) =>
            entry.sourceLabel === entities[target.sourceEntityIndex]?.name
            && entry.targetLabel === entities[target.targetEntityIndex]?.name
            && entry.relation === target.relation);
          noul = id.startsWith('b_relation_')
            ? (relation?.support ?? 0.01) : (relation?.missingContext ?? 1);
        } else throw new JevFault('unknown_fixture_question');
        answers[id] = { type: 'noul', noul };
      } else throw new JevFault('unknown_fixture_question');
    }
    return new Response(JSON.stringify({
      model: request.model, answers, usage: { input_tokens: 0, output_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  Object.defineProperty(fetchImpl, FIXTURE_TRANSPORT, { value: true });
  return fetchImpl;
}
