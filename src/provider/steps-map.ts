import type { WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { summarizeExecution, type LTExecutionExportOptions, type LTWorkflowExecution, type LTWorkflowExecutionEvent } from '@hotmeshio/long-tail';

import { DBOS_OP, DBOS_SYSTEM_STEPS, STEP } from '../constants';
import { toJobState } from './status';

/** The fields of a DBOS StepInfo the timeline reads. */
export interface DbosStep {
  functionID: number;
  name: string;
  output: unknown;
  error: unknown;
  childWorkflowID: string | null;
  startedAtEpochMs?: number;
  completedAtEpochMs?: number;
}

type Category = LTWorkflowExecutionEvent['category'];

/**
 * DBOS status + steps as the Long Tail execution timeline.
 *
 * - User steps become activity scheduled/completed (or failed) pairs.
 * - `lt.open` starts a signal wait; the next `DBOS.recv` ends it.
 * - A timed recv writes its deadline as `DBOS.sleep` at the next function id; it is folded in.
 * - A child start and its `DBOS.getResult` pair on the child id.
 * - Steps record outputs only; DBOS does not store step inputs.
 */
export function buildExecution(status: WorkflowStatus, steps: DbosStep[], options: LTExecutionExportOptions = {}): LTWorkflowExecution {
  const events: LTWorkflowExecutionEvent[] = [];
  const byId = new Map(steps.map((s) => [s.functionID, s]));
  const push = (event_type: string, category: Category, at: number | undefined, attrs: Record<string, unknown>, opts: { system?: boolean; duration?: number | null } = {}) => {
    if (opts.system && options.excludeSystem) return;
    events.push({
      event_id: events.length + 1,
      event_type,
      category,
      event_time: iso(at ?? status.createdAt),
      duration_ms: opts.duration ?? null,
      is_system: Boolean(opts.system),
      attributes: { kind: event_type, ...attrs },
    });
  };
  const result = (value: unknown) => (options.omitResults ? undefined : value);

  push('workflow_execution_started', 'workflow', status.createdAt, { input: result(status.input) });

  let openWaitKey: string | null = null;
  for (const step of steps) {
    const start = step.startedAtEpochMs;
    const end = step.completedAtEpochMs;
    if (step.name === STEP.OPEN) {
      const waitKey = (step.output as { waitKey?: string } | null)?.waitKey ?? null;
      pushActivity(push, step, true, result);
      if (waitKey) {
        openWaitKey = waitKey;
        push('signal_wait_started', 'signal', end ?? start, { signal_name: waitKey, timeline_key: `w:${waitKey}` });
      }
    } else if (step.name === DBOS_OP.RECV) {
      const key = openWaitKey ?? `recv:${step.functionID}`;
      push('workflow_execution_signaled', 'signal', end, { signal_name: key, timeline_key: `w:${key}`, input: result(step.output) });
      openWaitKey = null;
    } else if (step.name === DBOS_OP.SLEEP) {
      if (isRecvDeadline(step, byId)) continue;
      const duration = start !== undefined && end !== undefined ? end - start : null;
      push('timer_started', 'timer', start, { timeline_key: `t:${step.functionID}` }, { duration });
    } else if (step.childWorkflowID && step.name !== DBOS_OP.GET_RESULT) {
      push('child_workflow_execution_started', 'child_workflow', start, { child_workflow_id: step.childWorkflowID, timeline_key: `c:${step.childWorkflowID}` });
    } else if (step.childWorkflowID && step.name === DBOS_OP.GET_RESULT) {
      const type = step.error ? 'child_workflow_execution_failed' : 'child_workflow_execution_completed';
      push(type, 'child_workflow', end, { child_workflow_id: step.childWorkflowID, timeline_key: `c:${step.childWorkflowID}`, result: result(step.output), ...(step.error ? { failure: errorText(step.error) } : {}) });
    } else {
      pushActivity(push, step, DBOS_SYSTEM_STEPS.includes(step.name) || step.name.startsWith('DBOS.'), result);
    }
  }

  const state = toJobState(status.status);
  const closed = state !== 'running' && state !== 'unknown';
  if (closed) {
    const failed = state !== 'completed';
    push(failed ? 'workflow_execution_failed' : 'workflow_execution_completed', 'workflow', status.completedAt ?? status.updatedAt, failed
      ? { failure: errorText(status.error) }
      : { result: result(status.output) });
  }

  return {
    workflow_id: status.workflowID,
    workflow_type: status.workflowName,
    workflow_name: status.workflowName,
    task_queue: status.queueName ?? '',
    status: !closed ? 'running' : state === 'completed' ? 'completed' : 'failed',
    provider_status: status.status,
    start_time: iso(status.createdAt),
    close_time: closed && status.completedAt ? iso(status.completedAt) : null,
    duration_ms: closed && status.completedAt ? status.completedAt - status.createdAt : null,
    ...(status.parentWorkflowID ? { parent_workflow_id: status.parentWorkflowID } : {}),
    ...(closed && state === 'completed' ? { result: result(status.output) } : {}),
    events,
    summary: summarizeExecution(events),
  };
}

function pushActivity(
  push: (t: string, c: Category, at: number | undefined, a: Record<string, unknown>, o?: { system?: boolean; duration?: number | null }) => void,
  step: DbosStep,
  system: boolean,
  result: (v: unknown) => unknown,
): void {
  const key = `s:${step.functionID}`;
  push('activity_task_scheduled', 'activity', step.startedAtEpochMs, { activity_type: step.name, timeline_key: key }, { system });
  if (step.completedAtEpochMs === undefined) return;
  const duration = step.startedAtEpochMs !== undefined ? step.completedAtEpochMs - step.startedAtEpochMs : null;
  if (step.error) {
    push('activity_task_failed', 'activity', step.completedAtEpochMs, { activity_type: step.name, timeline_key: key, failure: errorText(step.error) }, { system, duration });
  } else {
    push('activity_task_completed', 'activity', step.completedAtEpochMs, { activity_type: step.name, timeline_key: key, result: result(step.output) }, { system, duration });
  }
}

/**
 * A timed recv writes its deadline as DBOS.sleep at the next function id. While
 * the recv waits its own row is absent; the deadline row records no elapsed time
 * and a wake time after it completed.
 */
function isRecvDeadline(step: DbosStep, byId: Map<number, DbosStep>): boolean {
  const before = byId.get(step.functionID - 1);
  if (before) return before.name === DBOS_OP.RECV;
  const wake = Number(step.output);
  return step.completedAtEpochMs !== undefined && Number.isFinite(wake) && wake > step.completedAtEpochMs;
}

function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function iso(ms: number | undefined): string {
  return new Date(ms ?? Date.now()).toISOString();
}
