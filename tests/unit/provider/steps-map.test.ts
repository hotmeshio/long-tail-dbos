import { describe, it, expect } from 'vitest';

import { buildExecution } from '../../../src/provider/steps-map';
// Recorded from a real DBOS 5.5 run (scripts/probe.ts): steps, timed recv, child, a failed step.
import run from '../../fixtures/dbos-run.json';

const types = (events: Array<{ event_type: string }>) => events.map((e) => e.event_type);

describe('DBOS steps as a Long Tail timeline', () => {
  const done = buildExecution(run.status as any, run.steps as any);

  it('frames the run with started and completed', () => {
    expect(done.status).toBe('completed');
    expect(done.provider_status).toBe('SUCCESS');
    expect(done.workflow_type).toBe('reviewOrder');
    expect(done.events[0]).toMatchObject({ event_type: 'workflow_execution_started', attributes: { input: ['order-7'] } });
    expect(done.events.at(-1)).toMatchObject({ event_type: 'workflow_execution_completed' });
    expect(done.duration_ms).toBe(run.status.completedAt - run.status.createdAt);
  });

  it('pairs the wait opened by lt.open with the recv that ended it', () => {
    const start = done.events.find((e) => e.event_type === 'signal_wait_started')!;
    const end = done.events.find((e) => e.event_type === 'workflow_execution_signaled')!;
    expect(start.attributes).toMatchObject({ signal_name: 'review-1', timeline_key: 'w:review-1' });
    expect(end.attributes).toMatchObject({ signal_name: 'review-1', timeline_key: 'w:review-1' });
    expect((end.attributes.input as any).status).toBe('resolved');
    expect(done.events.find((e) => e.attributes.activity_type === 'lt.open')?.is_system).toBe(true);
  });

  it('folds the recv deadline sleep and keeps a real sleep as a timer', () => {
    const timers = done.events.filter((e) => e.event_type === 'timer_started');
    expect(timers).toHaveLength(1);
    expect(timers[0].duration_ms).toBeGreaterThanOrEqual(40);
  });

  it('pairs the child start with its result and maps the failed step', () => {
    const child = done.events.filter((e) => e.category === 'child_workflow');
    expect(types(child)).toEqual(['child_workflow_execution_started', 'child_workflow_execution_completed']);
    expect(child[1].attributes).toMatchObject({ result: 42 });
    const failed = done.events.find((e) => e.event_type === 'activity_task_failed')!;
    expect(failed.attributes).toMatchObject({ activity_type: 'flaky', failure: 'boom' });
  });

  it('summarizes the run', () => {
    expect(done.summary.signals).toBe(1);
    expect(done.summary.timers).toBe(1);
    expect(done.summary.child_workflows).toEqual({ total: 1, completed: 1, failed: 0 });
    expect(done.summary.activities.failed).toBe(1);
  });

  it('shows a pending wait while the recv is parked', () => {
    const pending = buildExecution(run.midStatus as any, run.midSteps as any);
    expect(pending.status).toBe('running');
    expect(pending.close_time).toBeNull();
    expect(types(pending.events)).toContain('signal_wait_started');
    expect(types(pending.events)).not.toContain('workflow_execution_signaled');
    expect(pending.events.filter((e) => e.event_type === 'timer_started')).toHaveLength(1);
  });

  it('drops system steps and results when asked', () => {
    const sparse = buildExecution(run.status as any, run.steps as any, { excludeSystem: true, omitResults: true });
    expect(sparse.events.some((e) => e.is_system)).toBe(false);
    expect(sparse.result).toBeUndefined();
    expect(sparse.events.every((e) => e.attributes.result === undefined)).toBe(true);
  });

  it('matches the recorded timeline shape', () => {
    expect(done.events.map((e) => [e.event_type, e.category, e.is_system, e.attributes.timeline_key ?? null])).toMatchSnapshot();
  });
});
