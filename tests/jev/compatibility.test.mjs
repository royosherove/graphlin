import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionService } from '../../runtime/jev/index.mjs';
import { evidenceState } from '../../runtime/jev/questions.mjs';
import { JevFault, abortFault, withAbort } from '../../runtime/jev/wire.mjs';
import { candidate } from './helpers.mjs';

test('legacy configuration, evidence, and cancellation exports retain JevFault compatibility', async () => {
  assert.throws(() => createDecisionService({ limits: { concurrency: 0 } }),
    error => error instanceof JevFault && error.code === 'invalid_limits');
  const first = candidate();
  const conflicting = { ...first, label: 'other', text: 'conflicting' };
  assert.throws(() => evidenceState([first, conflicting]),
    error => error instanceof JevFault && error.code === 'inconsistent_evidence');
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE_REASON'));
  assert.ok(abortFault(controller.signal) instanceof JevFault);
  await assert.rejects(withAbort(() => null, controller.signal),
    error => error instanceof JevFault && error.code === 'cancelled');
});
