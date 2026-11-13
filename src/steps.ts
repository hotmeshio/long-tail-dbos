import { DBOS, Error as DBOSErrors } from '@dbos-inc/dbos-sdk';

import { STEP, WAIT_DEFAULTS } from './constants';
import { toMs } from './duration';
import { postCancel, postOpenWait } from './lt-client';
import type { LTCollectionConfig, LTConditionalConfig, OpenedWait } from './types';

/** Open the escalation this workflow waits on. Runs as a checkpointed step. */
export async function openWait(waitKey: string, config: LTConditionalConfig): Promise<OpenedWait> {
  const workflowId = DBOS.workflowID;
  if (!workflowId) throw new Error('conditional() must run inside a DBOS workflow');
  const status = await DBOS.getWorkflowStatus(workflowId);
  const workflowType = status?.workflowName ?? null;
  const expiresAt = config.timeout !== undefined ? new Date(Date.now() + toMs(config.timeout)).toISOString() : null;
  const opened = await postOpenWait({
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

/** Cancel the escalation when the recv deadline passes first. */
export async function closeWait(escalationId: string): Promise<void> {
  await postCancel(escalationId);
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
