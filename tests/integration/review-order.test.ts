import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { reviewOrder } from '../../examples/review-order/workflow';
import { api, deliveryOf, eventually, launchDbos, recreateDatabases, startLongTail, type Harness } from './harness';

interface Row { id: string; status: string; role: string; workflow_id: string; workflow_type: string; metadata: Record<string, unknown> }

describe('Long Tail on DBOS: review order', () => {
  let lt: Harness;

  const rowsFor = async (workflowId: string): Promise<Row[]> => {
    const data = await api<Row[] | { escalations: Row[] }>('GET', `/api/escalations/by-workflow/${workflowId}`, lt.adminToken);
    return Array.isArray(data) ? data : data.escalations;
  };
  const pendingRow = (workflowId: string) => eventually(async () => (await rowsFor(workflowId)).find((r) => r.status === 'pending'), `escalation for ${workflowId}`);
  const resolve = (id: string, payload: Record<string, unknown>) => api('POST', `/api/escalations/${id}/resolve`, lt.adminToken, { resolverPayload: payload });

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();
  });

  afterAll(async () => {
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  it('opens an escalation, resolves it, and the workflow completes with the payload', async () => {
    const id = `review-golden-${Date.now()}`;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-1');

    const row = await pendingRow(id);
    expect(row).toMatchObject({ role: 'reviewer', workflow_type: 'reviewOrder' });
    expect(row.metadata).toMatchObject({ orderId: 'order-1' });

    await resolve(row.id, { approved: true, notes: 'looks right' });
    await expect(handle.getResult()).resolves.toEqual({
      orderId: 'order-1', status: 'shipped', decision: { approved: true, notes: 'looks right' },
    });

    const execution = await api<any>('GET', `/api/workflow-states/${id}/execution`, lt.adminToken);
    const types = execution.events.map((e: { event_type: string }) => e.event_type);
    expect(execution.status).toBe('completed');
    expect(types).toContain('signal_wait_started');
    expect(types).toContain('workflow_execution_signaled');
    const wait = execution.events.find((e: any) => e.event_type === 'signal_wait_started');
    expect(wait.attributes.signal_name).toBe('review-order-1');
    expect(execution.events.some((e: any) => e.attributes.activity_type === 'score')).toBe(true);
  });

  it('describes the workflow through the engine-neutral endpoint', async () => {
    const id = `review-describe-${Date.now()}`;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-2');
    const row = await pendingRow(id);
    const running = await api<any>('GET', `/api/workflows/${id}/describe`, lt.adminToken);
    expect(running).toMatchObject({ workflowId: id, workflowType: 'reviewOrder', state: 'running', providerState: 'PENDING' });
    await resolve(row.id, { approved: false });
    await expect(handle.getResult()).resolves.toMatchObject({ status: 'rejected' });
  });

  it('returns false when the escalation expires', async () => {
    const id = `review-expire-${Date.now()}`;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-3', '1s');
    await expect(handle.getResult()).resolves.toEqual({ orderId: 'order-3', status: 'expired' });
    expect((await rowsFor(id))[0].status).toBe('expired');
  });

  it('returns null when a person cancels the escalation', async () => {
    const id = `review-cancel-${Date.now()}`;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-4');
    const row = await pendingRow(id);
    await api('POST', `/api/escalations/${row.id}/cancel`, lt.adminToken, {});
    await expect(handle.getResult()).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('delivers an outcome resolved while the DBOS process is down', async () => {
    const id = `review-restart-${Date.now()}`;
    await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-5');
    const row = await pendingRow(id);

    await DBOS.shutdown();
    await resolve(row.id, { approved: true });
    // Still PENDING in the system database, so the relay stores the message for the replay.
    expect(await deliveryOf(row.id)).toBe('delivered');

    await launchDbos();
    await expect(DBOS.retrieveWorkflow(id).getResult()).resolves.toMatchObject({ status: 'shipped' });
  });

  it('redelivers after a rewind re-runs the wait', async () => {
    const id = `review-rewind-${Date.now()}`;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-6');
    const row = await pendingRow(id);
    await resolve(row.id, { approved: true, notes: 'first' });
    await expect(handle.getResult()).resolves.toMatchObject({ status: 'shipped' });

    const steps = (await DBOS.listWorkflowSteps(id)) ?? [];
    const openStep = steps.find((s) => s.name === 'lt.open')!;
    const rewound = await DBOS.rewindWorkflow(id, { startStep: openStep.functionID });
    await expect(rewound.getResult()).resolves.toMatchObject({ status: 'shipped', decision: { notes: 'first' } });
  });
});
