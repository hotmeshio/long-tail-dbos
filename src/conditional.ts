import { DBOS } from '@dbos-inc/dbos-sdk';

import { CLOSE_REASON_DEADLINE, WAIT_DEFAULTS } from './constants';
import { toMs } from './duration';
import { ltClose, ltOpen } from './steps';
import type { LTConditionalConfig, LTWaitOutcome } from './types';

/**
 * Wait for a person (or machine) through Long Tail.
 *
 * Opens an escalation in `config.role`, parks the workflow in DBOS.recv, and
 * returns the resolver payload. Returns null when the escalation expires or
 * is cancelled. A `batch` or `accumulate` wait returns its collection, also
 * on an expiry that kept one (an accumulator, or `partialOnTimeout`).
 * `key` is unique per wait within one workflow.
 */
export async function conditional<T = Record<string, unknown>>(key: string, config: LTConditionalConfig): Promise<T | null> {
  if (!key) throw new Error('conditional(key): key is required');
  if (!config?.role || !config.type) throw new Error('conditional(key, config): role and type are required');
  if (!DBOS.isInWorkflow()) throw new Error('conditional() must run in a DBOS workflow body, not inside a step');

  // 1. Open the wait (idempotent on workflowId + key)
  const opened = await ltOpen(key, config);

  // 2. Park until Long Tail delivers; DBOS defaults recv to 60 s, so the deadline is explicit
  const outcome = await DBOS.recv<LTWaitOutcome>(key, { timeoutSeconds: waitSeconds(config) });

  // 3. No outcome means the backstop passed first: close the row
  if (!outcome) {
    DBOS.logger.warn(`long-tail-dbos: ${key} reached its recv deadline (${CLOSE_REASON_DEADLINE}); cancelling ${opened.escalationId}`);
    await ltClose(opened.escalationId);
    return null;
  }
  if (outcome.status === 'resolved') return (outcome.data ?? {}) as T;
  return outcome.status === 'expired' && outcome.data ? (outcome.data as T) : null;
}

/** recv deadline: the SLA plus a grace period, or the max wait when there is no SLA. */
export function waitSeconds(config: LTConditionalConfig): number {
  if (config.timeout !== undefined) {
    return Math.ceil(toMs(config.timeout) / 1000) + WAIT_DEFAULTS.GRACE_SECONDS;
  }
  return config.maxWaitSeconds ?? WAIT_DEFAULTS.MAX_WAIT_SECONDS;
}
