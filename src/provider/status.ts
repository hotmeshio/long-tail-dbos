import { StatusString, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { JOB_STATE, type LTJobState, type LTJobStatus } from '@hotmeshio/long-tail';

const RUNNING: string[] = [StatusString.PENDING, StatusString.ENQUEUED, 'DELAYED', 'SUSPENDED'];
const FAILED: string[] = [StatusString.ERROR, StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED];

export function toJobState(status: string | undefined): LTJobState {
  if (!status) return JOB_STATE.UNKNOWN;
  if (RUNNING.includes(status)) return JOB_STATE.RUNNING;
  if (status === StatusString.SUCCESS) return JOB_STATE.COMPLETED;
  if (status === StatusString.CANCELLED) return JOB_STATE.CANCELLED;
  if (FAILED.includes(status)) return JOB_STATE.FAILED;
  return JOB_STATE.UNKNOWN;
}

/** True once the workflow can no longer receive a message. */
export function isTerminal(status: string): boolean {
  return !RUNNING.includes(status);
}

export function toJobStatus(workflowId: string, status: WorkflowStatus | undefined | null): LTJobStatus {
  if (!status) return { workflowId, state: JOB_STATE.UNKNOWN, providerState: 'NOT_FOUND' };
  return {
    workflowId,
    workflowType: status.workflowName,
    state: toJobState(status.status),
    providerState: status.status,
    startedAt: new Date(status.createdAt).toISOString(),
    ...(status.completedAt ? { closedAt: new Date(status.completedAt).toISOString() } : {}),
  };
}
