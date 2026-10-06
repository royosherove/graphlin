import { DecisionFault } from '../decisions/faults.mjs';
import { createSystemOneWire } from '../systemone/wire.mjs';

export class JevFault extends DecisionFault {
  constructor(code, status = 'invalid') {
    super(code, status);
    this.name = 'JevFault';
    this.code = code;
    this.status = status;
  }
}

// The System One rules are shared (runtime/systemone/wire.mjs). Jev keeps
// JevFault for each error, thus the old exports do not change.
const wire = createSystemOneWire(JevFault);
export const { abortFault, withAbort, validateResponse, readResponse } = wire;
export { isRecord, isProbability } from '../systemone/wire.mjs';
