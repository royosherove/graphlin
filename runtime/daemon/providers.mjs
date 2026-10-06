// The only selection point for the decision provider. The default start
// (in-process), the background worker, MCP start and the evaluation script
// all make their provider here, from a plain configuration.
import { createJevProvider } from '../jev/provider.mjs';
import {
  createDeciderProvider, deciderEndpoint, validDeciderModel,
  DEFAULT_DECIDER_ENDPOINT, DEFAULT_DECIDER_MODEL,
} from '../decider/provider.mjs';
import { DEFAULT_ADMISSION_POLICY } from '../decisions/index.mjs';
import { runtimeError } from './paths.mjs';

export const PROVIDER_IDS = Object.freeze(['jev', 'decider']);
export const JEV_PROVIDER = Object.freeze({ id: 'jev' });
export { DEFAULT_DECIDER_ENDPOINT, DEFAULT_DECIDER_MODEL };

// Decision service limits for each provider. Jev keeps its old limits.
// activityTargetDeadlineMs is the deadline of an activity target. The
// pipeline gives it to the target path. The decision service does not get it.
export const JEV_LIMITS = Object.freeze({ eventDeadlineMs: 5000, activityTargetDeadlineMs: 1500 });
// Final values. With these limits, most requests fit in the 4096-token window.
// This is the only place for these numbers. The byte cap does not protect the
// 4096-token window: the server answers 422 when a request is too long.
// With concurrency 1, a target waits behind the event classifications. A hook
// does not wait for the target result, thus 5000 ms stops no coding agent.
export const DECIDER_LIMITS = Object.freeze({
  eventDeadlineMs: 5000, concurrency: 1, maxCandidates: 7, maxRequestBytes: 65536,
  activityTargetDeadlineMs: 5000,
});
// Decider uses the Jev thresholds with its own policy version, until
// evaluation data sets decider thresholds.
export const DECIDER_ADMISSION_POLICY = Object.freeze({
  ...DEFAULT_ADMISSION_POLICY, version: 'admission-policy-v1-decider-experimental',
});
// Decider intake policy. For normal source, the decider model gives sensitive
// values above the Jev value 0.1, thus the Jev value refuses each candidate.
// The value 0.3 is provisional: later evaluation data must set the final value.
export const DECIDER_INTAKE_POLICY = Object.freeze({
  version: 'intake-policy-v1-decider-experimental', relevantMin: 0.5, sensitiveMax: 0.3,
});

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validator for the saved settings value `decisionProvider`. */
export function validProviderSetting(value) {
  if (!record(value)) return false;
  if (value.id === 'jev') return Object.keys(value).length === 1;
  return value.id === 'decider' && Object.keys(value).length === 3
    && Object.keys(value).every(key => ['id', 'endpoint', 'model'].includes(key))
    && deciderEndpoint(value.endpoint) === value.endpoint && validDeciderModel(value.model);
}

// A saved http://[::1]:<port>/v1/systemone value is not valid: the decider
// server refuses that Host. The settings can still read it, so that each
// start stops with invalid_provider and the hint names the repair command.
// No start can use this value.
const RETIRED_ENDPOINT = /^http:\/\/\[::1\](?::\d{1,5})?\/v1\/systemone$/;
export function retiredProviderSetting(value) {
  return record(value) && value.id === 'decider' && Object.keys(value).length === 3
    && Object.keys(value).every(key => ['id', 'endpoint', 'model'].includes(key))
    && typeof value.endpoint === 'string' && RETIRED_ENDPOINT.test(value.endpoint) && validDeciderModel(value.model);
}

// The next step for invalid_provider, for the CLI and doctor.
export const INVALID_PROVIDER_STEP = 'The decider endpoint must be http://127.0.0.1:<port>/v1/systemone. '
  + 'The model name must start with strands-decider- and have 64 characters or fewer. To repair a saved value, '
  + `run graphlin provider decider (default endpoint ${DEFAULT_DECIDER_ENDPOINT}), or graphlin provider jev to go back to Jev.`;

/**
 * Return a frozen plain configuration: { id: 'jev' } or
 * { id: 'decider', endpoint, model }. No value means Jev. A value that is not
 * valid stops the start with invalid_provider. It never falls back to Jev.
 */
export function resolveProviderConfig(value) {
  if (value === undefined || value === null) return JEV_PROVIDER;
  if (!validProviderSetting(value)) throw runtimeError('invalid_provider');
  return Object.freeze({ ...value });
}

/** Make a decider configuration from the CLI values; unset values get the defaults. */
export function deciderConfig({ endpoint, model } = {}) {
  const normalized = deciderEndpoint(endpoint ?? DEFAULT_DECIDER_ENDPOINT);
  const config = { id: 'decider', endpoint: normalized, model: model ?? DEFAULT_DECIDER_MODEL };
  if (!normalized || !validProviderSetting(config)) throw runtimeError('invalid_provider');
  return Object.freeze(config);
}

export function sameProvider(left, right) {
  const a = left ?? JEV_PROVIDER, b = right ?? JEV_PROVIDER;
  return a.id === b.id && a.endpoint === b.endpoint && a.model === b.model;
}

/** Worker-only arguments. The configuration is not secret; the key is never an argument. */
export function providerArguments(config) {
  const value = resolveProviderConfig(config);
  return value.id === 'decider'
    ? ['--provider', 'decider', '--decider-endpoint', value.endpoint, '--decider-model', value.model]
    : [];
}

/** Read the worker-only arguments back into a configuration. */
export function providerFromArguments({ provider, deciderEndpoint: endpoint, deciderModel: model } = {}) {
  if (provider === undefined && endpoint === undefined && model === undefined) return JEV_PROVIDER;
  if (provider !== 'decider') throw runtimeError('invalid_provider');
  return resolveProviderConfig({ id: 'decider', endpoint, model });
}

/** Only Jev uses a key. */
export const providerNeedsKey = config => (config ?? JEV_PROVIDER).id === 'jev';

/** Safe, non-secret description for health, doctor and the CLI. */
export function describeProvider(config) {
  const value = config ?? JEV_PROVIDER;
  return value.id === 'decider'
    ? { id: 'decider', experimental: true, endpoint: value.endpoint, model: value.model }
    : { id: 'jev' };
}

/**
 * The description for doctor and `graphlin provider`. For decider, it also
 * shows the limits, the intake policy and the admission policy version.
 * These values come from this file, not from a running daemon.
 */
export function describeProviderDetails(config) {
  const value = resolveProviderConfig(config);
  return value.id === 'decider'
    ? { ...describeProvider(value), limits: { ...DECIDER_LIMITS }, intakePolicy: { ...DECIDER_INTAKE_POLICY },
      admissionPolicyVersion: DECIDER_ADMISSION_POLICY.version }
    : describeProvider(value);
}

export function createConfiguredProvider(config, { apiKey, transmitSource = false, fetchImpl } = {}) {
  const value = resolveProviderConfig(config);
  if (value.id === 'decider') {
    return createDeciderProvider({ endpoint: value.endpoint, model: value.model, transmitSource: Boolean(transmitSource),
      ...(fetchImpl ? { fetchImpl } : {}) });
  }
  return createJevProvider({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** Options for createDecisionService, other than the provider and the core. */
export function decisionServiceOptions(config) {
  return resolveProviderConfig(config).id === 'decider'
    ? { limits: serviceLimits(DECIDER_LIMITS), intakePolicy: DECIDER_INTAKE_POLICY, admissionPolicy: DECIDER_ADMISSION_POLICY }
    : { limits: serviceLimits(JEV_LIMITS) };
}

// The decision service refuses limits that it does not know.
function serviceLimits({ activityTargetDeadlineMs, ...limits }) {
  return Object.freeze(limits);
}

/** The deadline of an activity target, from the provider limits. */
export function activityTargetDeadline(config) {
  return (resolveProviderConfig(config).id === 'decider' ? DECIDER_LIMITS : JEV_LIMITS).activityTargetDeadlineMs;
}
