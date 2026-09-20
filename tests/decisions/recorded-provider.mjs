// An alternate provider with no HTTP, model, key, environment, or vendor types.
// These are literal synthetic recordings, not source interpretation.
export const capabilities = Object.freeze({
  boolean: { probability: true },
  choice: { probabilities: true, confidence: true },
  score: { probabilities: true, confidence: true },
});

export function recordedResult(request) {
  return {
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      if (question.type === 'boolean') return [id, {
        type: 'boolean', probability: id.startsWith('a_sensitive_') || id.startsWith('b_context_') ? 0.01 : 0.97,
      }];
      if (question.type === 'score') return [id, {
        type: 'score', score: 1, confidence: 0.95,
        probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])),
      }];
      const keys = Object.keys(question.criteria);
      const choice = id === 'a_activity' ? 'implement'
        : id.startsWith('b_role_') ? (request.state.entities[Number(id.slice(7))].name === 'PostgreSQL'
          ? 'datastore' : 'module') : keys[0];
      const fallback = keys.includes('other') ? 'other' : keys.includes('unknown') ? 'unknown' : keys[1];
      return [id, {
        type: 'choice', choice, confidence: 0.95,
        probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 0.94 : key === fallback ? 0.06 : 0])),
      }];
    })),
    usage: null,
  };
}

export function createRecordedProvider({ transform = value => value, ...overrides } = {}) {
  const calls = [];
  return {
    contractVersion: 1, id: 'recorded', version: '1', mode: 'local', capabilities, calls,
    encode: request => JSON.stringify(request),
    async execute(encoded, context) {
      const request = JSON.parse(encoded);
      calls.push({ request, context });
      return transform(recordedResult(request), request, calls.length, context);
    },
    ...overrides,
  };
}
