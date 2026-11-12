import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { LongTail, PushListener, ROLE, runId, startReview } from './stack';

describe('e2e: a DBOS review through Long Tail', () => {
  let admin: LongTail;
  let push: PushListener;

  beforeAll(async () => {
    admin = await LongTail.login();
    push = await PushListener.connect(admin.token, ['lt.events.system.workflow.>', 'lt.events.system.escalation.>']);
  });

  afterAll(() => push?.close());

  it('opens the escalation with the role, type, facets and data the workflow declared', async () => {
    const orderId = runId('open');
    const workflowId = await startReview(orderId);
    const row = await admin.pendingEscalation(workflowId);

    expect(row).toMatchObject({ role: ROLE, type: 'order-review', workflow_type: 'reviewOrder', workflow_id: workflowId });
    expect(row.metadata).toMatchObject({ orderId });
    const payload = typeof row.escalation_payload === 'string' ? JSON.parse(row.escalation_payload) : row.escalation_payload;
    expect(payload).toEqual({ risk: expect.any(Number) });

    await admin.resolve(row.id, { approved: false });
    await admin.closedExecution(workflowId);
  });

  it('claim and resolve complete the workflow with the resolver payload', async () => {
    const workflowId = await startReview(runId('ship'));
    const row = await admin.pendingEscalation(workflowId);

    await admin.claim(row.id);
    await admin.resolve(row.id, { approved: true, notes: 'looks right' });

    const execution = await admin.closedExecution(workflowId);
    expect(execution).toMatchObject({ status: 'completed', provider_status: 'SUCCESS' });
    expect(execution.result).toMatchObject({ status: 'shipped', decision: { approved: true, notes: 'looks right' } });
    expect((await admin.escalationsFor(workflowId))[0].status).toBe('resolved');
  });

  it('a rejection reaches the workflow as data', async () => {
    const workflowId = await startReview(runId('reject'));
    const row = await admin.pendingEscalation(workflowId);
    await admin.resolve(row.id, { approved: false, notes: 'wrong size' });

    const execution = await admin.closedExecution(workflowId);
    expect(execution.result).toMatchObject({ status: 'rejected', decision: { approved: false, notes: 'wrong size' } });
  });

  it('pushes escalation.resolved and then workflow.completed to the dashboard', async () => {
    const workflowId = await startReview(runId('push'));
    const row = await admin.pendingEscalation(workflowId);
    const resolvedAt = Date.now();
    await admin.resolve(row.id, { approved: true });

    const resolved = await push.waitFor((e) => e.type?.startsWith('system.escalation.') && e.type.endsWith('.resolved') && e.type.includes(row.id), 'escalation.resolved');
    const completed = await push.waitFor((e) => e.type === `system.workflow.${workflowId}.completed`, 'workflow.completed');

    expect(completed.at).toBeGreaterThanOrEqual(resolved.at);
    expect(completed.at - resolvedAt).toBeLessThan(15_000);
  });

  it('records the wait and the signal in the execution timeline', async () => {
    const orderId = runId('timeline');
    const workflowId = await startReview(orderId);
    const row = await admin.pendingEscalation(workflowId);
    await admin.resolve(row.id, { approved: true });

    const execution = await admin.closedExecution(workflowId);
    const types = execution.events.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['signal_wait_started', 'workflow_execution_signaled']));
    const wait = execution.events.find((e: any) => e.event_type === 'signal_wait_started');
    expect(wait.attributes.signal_name).toBe(`review-${orderId}`);
  });
});
