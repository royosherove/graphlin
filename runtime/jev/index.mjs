// Compatibility entry point: existing callers still select the Jev adapter.
import { createDecisionService as createService } from '../decisions/index.mjs';
import { DecisionFault } from '../decisions/faults.mjs';
import { createJevProvider } from './provider.mjs';
import { JevFault } from './wire.mjs';

export { DEFAULT_LIMITS, DEFAULT_INTAKE_POLICY, DEFAULT_ADMISSION_POLICY } from '../decisions/index.mjs';
export { createFixtureTransport } from './fixture.mjs';
export { createJevProvider } from './provider.mjs';

export function createDecisionService(options = {}) {
  try {
    return createService({ ...options, provider: createJevProvider(options) });
  } catch (error) {
    if (error instanceof DecisionFault && !(error instanceof JevFault)) {
      throw new JevFault(error.code, error.status);
    }
    throw error;
  }
}
