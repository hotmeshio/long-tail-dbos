import { DBOS, Error as DBOSErrors } from '@dbos-inc/dbos-sdk';

import { ESCALATION_STATUS, STEP, WAIT_DEFAULTS } from './constants';
import { toMs } from './duration';
import { requestCancel, requestEscalation, requestOpenWait, type EscalationState } from './lt-client';
import type { LTCollectionConfig, LTConditionalConfig, LTWaitFields, LTWaitOutcome, OpenedWait } from './types';

/** Open the escalation this workflow waits on. Runs as a checkpointed step. */
export async function openWait(waitKey: string, config: LTConditionalConfig): Promise<OpenedWait> {
  const workflowId = DBOS.workflowID;
  if (!workflowId) throw new Error('conditional() must run inside a DBOS workflow');
  const status = await DBOS.getWorkflowStatus(workflowId);
  const workflowType = status?.workflowName ?? null;
  const expiresAt = config.timeout !== undefined ? new Date(Date.now() + toMs(config.timeout)).toISOString() : null;
  const opened = await requestOpenWait({
    workflowId,
    runScope: '',
    ...(workflowType ? { workflowType } : {}),
    waitKey,
    role: config.role,
    type: config.type,
    subtype: config.subtype,
    description: config.description,
    priority: config.priority,
    metadata: config.metadata,
    data: config.data,
    ...(expiresAt ? { expiresAt } : {}),
    ...collectionOf(config),
    ...waitFieldsOf(config),
  });
  return { escalationId: opened.escalationId, waitKey, status: opened.status, expiresAt, workflowType };
}

/** The batch or accumulate declaration, only the fields the config sets. */
function collectionOf(config: LTConditionalConfig): LTCollectionConfig {
  const { batch, filled, wakeOnFill, wakeOnFlag, partialOnTimeout, accumulate } = config;
  return Object.fromEntries(
    Object.entries({ batch, filled, wakeOnFill, wakeOnFlag, partialOnTimeout, accumulate }).filter(([, v]) => v !== undefined),
  );
}

/** The envelope, assignment, lineage and signal key, only the fields the config sets. */
function waitFieldsOf(config: LTConditionalConfig): LTWaitFields {
  const { envelope, lookups, files, schemaVersion, assignee, durationMinutes, originId, parentId, signalKey } = config;
  return Object.fromEntries(
    Object.entries({ envelope, lookups, files, schemaVersion, assignee, durationMinutes, originId, parentId, signalKey }).filter(([, v]) => v !== undefined),
  );
}

/**
 * Settle the wait when the recv deadline passes first. The row decides: an
 * outcome Long Tail committed but has not delivered yet is returned as is;
 * a row still pending is cancelled, then read again, because a resolve may
 * win the race with the cancel.
 */
export async function closeWait(escalationId: string, waitKey: string): Promise<LTWaitOutcome> {
  // 1. Read the row
  const row = await requestEscalation(escalationId);
  if (row.status !== ESCALATION_STATUS.PENDING) return outcomeOf(escalationId, waitKey, row);

  // 2. Cancel it, then read what was committed
  await requestCancel(escalationId);
  const settled = await requestEscalation(escalationId);
  if (settled.status === ESCALATION_STATUS.PENDING) {
    throw new Error(`long-tail-dbos: escalation ${escalationId} is still pending after cancel`);
  }
  return outcomeOf(escalationId, waitKey, settled);
}

/** The outcome a delivery would have carried for this row. */
function outcomeOf(escalationId: string, waitKey: string, row: EscalationState): LTWaitOutcome {
  const data = typeof row.resolver_payload === 'string' ? JSON.parse(row.resolver_payload) : row.resolver_payload;
  const at = row.resolved_at ?? row.updated_at;
  return {
    waitKey,
    escalationId,
    status: row.status as LTWaitOutcome['status'],
    ...(data && row.status !== ESCALATION_STATUS.CANCELLED ? { data } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
    ...(at ? { resolvedAt: new Date(at).toISOString() } : {}),
  };
}

function register<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>, name: string) {
  try {
    return DBOS.registerStep(fn, { name, retriesAllowed: true, maxAttempts: WAIT_DEFAULTS.OPEN_ATTEMPTS });
  } catch (err) {
    if (err instanceof DBOSErrors.DBOSConflictingRegistrationError) {
      throw new Error(`@hotmeshio/long-tail-dbos must be imported before DBOS.launch(): its ${name} step registers at import`, { cause: err });
    }
    throw err;
  }
}

export const ltOpen = register(openWait, STEP.OPEN);
export const ltClose = register(closeWait, STEP.CLOSE);
