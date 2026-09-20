import { createJevProvider } from '../../runtime/jev/provider.mjs';
import { recordedResult } from './recorded-provider.mjs';

export function jevProvider(transform = value => value) {
  const calls = [];
  return {
    ...createJevProvider({
      apiKey: 'synthetic-test-key',
      fetchImpl: async (_url, options) => {
        const wire = JSON.parse(options.body);
        const request = {
          state: wire.state,
          questions: Object.fromEntries(Object.entries(wire.questions).map(([id, question]) =>
            [id, { ...question, type: question.type === 'noul' ? 'boolean' : question.type }])),
        };
        calls.push({ request, context: { signal: options.signal } });
        const value = await transform(recordedResult(request), request, calls.length, { signal: options.signal });
        const answers = Object.fromEntries(Object.entries(value.answers).map(([id, answer]) => [id,
          answer.type === 'boolean' ? { type: 'noul', noul: answer.probability }
            : answer.type === 'score' ? {
              ...answer, legend: Object.fromEntries(wire.questions[id].criteria.map((label, i) => [String(i), label])),
            } : answer,
        ]));
        return new Response(JSON.stringify({
          model: wire.model, answers, usage: { input_tokens: 10, output_tokens: 5 },
        }));
      },
    }),
    calls,
  };
}

