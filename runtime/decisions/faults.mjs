export class DecisionFault extends Error {
  constructor(code, status = 'invalid', { retryAfterMs } = {}) {
    super(code);
    this.name = 'DecisionFault';
    this.code = code;
    this.status = status;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}

export function abortFault(signal) {
  return signal.reason instanceof DecisionFault
    ? signal.reason : new DecisionFault('cancelled', 'abstained');
}

// Providers may ignore cancellation; the service must still settle on time.
export async function withAbort(operation, signal) {
  if (signal.aborted) throw abortFault(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortFault(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw abortFault(signal);
      return operation();
    }), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
