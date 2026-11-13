import { DBOS } from '@dbos-inc/dbos-sdk';

import { CLOSE_REASON_DEADLINE, ESCALATION_STATUS, WAIT_DEFAULTS } from './constants';
import { toMs } from './duration';
import { ltClose, ltOpen } from './steps';
import type { LTConditionalConfig, LTOutcome, LTResolution, LTWaitOutcome, LTWithResolution, OpenedWait } from './types';

const PRIORITIES = [1, 2, 3, 4];

/**
 * Wait for a person (or machine) through Long Tail.
 *
 * Opens an escalation in `config.role`, parks the workflow in DBOS.recv, and
 * returns what HotMesh's `conditional()` returns: the resolver payload when
 * resolved, `false` when it expires, `null` when it is cancelled. A `batch`
 * or `accumulate` wait returns its collection, also on an expiry that kept
 * one (an accumulator, or `partialOnTimeout`), so an accumulator never
 * returns `false`. `withResolution: true` adds `$resolution` to a resolved
 * payload. `key` is unique per wait within one workflow.
 */
export async function conditional<T = Record<string, unknown>>(
  key: string,
  config: LTConditionalConfig & { accumulate: object; withResolution?: false },
): Promise<T | null>;
export async function conditional<T = Record<string, unknown>>(
  key: string,
  config: LTConditionalConfig & { withResolution: true },
): Promise<LTWithResolution<T> | false | null>;
export async function conditional<T = Record<string, unknown>>(key: string, config: LTConditionalConfig): Promise<T | false | null>;
export async function conditional<T = Record<string, unknown>>(
  key: string,
  config: LTConditionalConfig,
): Promise<T | LTWithResolution<T> | false | null> {
  const outcome = await conditionalOutcome<T>(key, config);
  if (outcome.status === ESCALATION_STATUS.EXPIRED) return outcome.data ?? false;
  if (outcome.status !== ESCALATION_STATUS.RESOLVED) return null;
  if (!config.withResolution) return outcome.data as T;
  const $resolution: LTResolution = { escalationId: outcome.escalationId, resolvedBy: outcome.resolvedBy, resolvedAt: outcome.resolvedAt };
  return { ...(outcome.data as T), $resolution };
}

/**
 * Wait as `conditional()` does, and return the raw record: how the wait
 * ended, its data, the escalation id, and who closed it when.
 */
export async function conditionalOutcome<T = Record<string, unknown>>(key: string, config: LTConditionalConfig): Promise<LTOutcome<T>> {
  assertWaitable(key, config);

  // 1. Open the wait (idempotent on workflowId + key)
  const opened = await ltOpen(key, config);

  // 2. Park until Long Tail delivers; DBOS defaults recv to 60 s, so the deadline is explicit
  const delivered = await DBOS.recv<LTWaitOutcome>(key, { timeoutSeconds: waitSeconds(config) });
  if (delivered) return outcomeOf<T>(delivered, opened);

  // 3. No outcome means the backstop passed first: the row's own outcome decides
  DBOS.logger.warn(`long-tail-dbos: ${key} reached its recv deadline (${CLOSE_REASON_DEADLINE}); settling ${opened.escalationId}`);
  return outcomeOf<T>(await ltClose(opened.escalationId, key), opened);
}

/** recv deadline: the SLA plus a grace period, or the max wait when there is no SLA. */
export function waitSeconds(config: LTConditionalConfig): number {
  if (config.timeout !== undefined) {
    return Math.ceil(toMs(config.timeout) / 1000) + WAIT_DEFAULTS.GRACE_SECONDS;
  }
  return config.maxWaitSeconds ?? WAIT_DEFAULTS.MAX_WAIT_SECONDS;
}

function assertWaitable(key: string, config: LTConditionalConfig): void {
  if (!key) throw new Error('conditional(key): key is required');
  if (!config?.role || !config.type) throw new Error('conditional(key, config): role and type are required');
  if (config.priority !== undefined && !PRIORITIES.includes(config.priority)) {
    throw new Error('conditional(key, config): priority must be 1, 2, 3 or 4');
  }
  if (config.schemaVersion !== undefined && !(Number.isInteger(config.schemaVersion) && config.schemaVersion > 0)) {
    throw new Error('conditional(key, config): schemaVersion must be a positive integer');
  }
  if (config.durationMinutes !== undefined) {
    if (!(Number.isFinite(config.durationMinutes) && config.durationMinutes > 0)) throw new Error('conditional(key, config): durationMinutes must be a positive number');
    if (!config.assignee) throw new Error('conditional(key, config): durationMinutes requires assignee');
  }
  if (!DBOS.isInWorkflow()) throw new Error('conditional() must run in a DBOS workflow body, not inside a step');
}

/**
 * The outcome as callers see it: data on a resolve, and on an expiry that
 * kept a collection. A step recorded by an earlier version returns nothing;
 * that version settled the wait as cancelled.
 */
function outcomeOf<T>(outcome: LTWaitOutcome | undefined, opened: OpenedWait): LTOutcome<T> {
  const status = outcome?.status ?? ESCALATION_STATUS.CANCELLED;
  const kept = status === ESCALATION_STATUS.EXPIRED && outcome?.data ? (outcome.data as T) : null;
  return {
    status,
    data: status === ESCALATION_STATUS.RESOLVED ? ((outcome?.data ?? {}) as T) : kept,
    escalationId: outcome?.escalationId ?? opened.escalationId,
    resolvedBy: outcome?.resolvedBy ?? null,
    resolvedAt: outcome?.resolvedAt ?? null,
  };
}
