// Compatibility wire builders; the shared catalog is provider independent.
import { buildIntakeQuestions, buildGraphQuestions, evidenceState as neutralEvidenceState } from '../decisions/questions.mjs';
import { DecisionFault } from '../decisions/faults.mjs';
import { toJevRequest } from './provider.mjs';
import { JevFault } from './wire.mjs';
export { ROLES, RELATIONS, RUBRICS, ACTIVITIES } from '../decisions/questions.mjs';

function compatible(operation) {
  try { return operation(); }
  catch (error) {
    if (error instanceof DecisionFault && !(error instanceof JevFault)) {
      throw new JevFault(error.code, error.status);
    }
    throw error;
  }
}

export function evidenceState(candidates) {
  return compatible(() => neutralEvidenceState(candidates));
}
export function buildIntakeRequest(model, event, candidates) {
  return compatible(() => toJevRequest(model, buildIntakeQuestions(event, candidates)));
}
export function buildGraphRequest(model, event, bundle, proposals) {
  return compatible(() => toJevRequest(model, buildGraphQuestions(event, bundle, proposals)));
}
