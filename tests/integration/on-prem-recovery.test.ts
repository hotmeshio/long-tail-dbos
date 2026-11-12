import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { reviewOrder } from '../../examples/review-order/workflow';
import { auditedReview, deployed } from './audited-review';
import { api, eventually, launchDbos, recreateDatabases, REPLICA, startLongTail, type Harness } from './harness';

// Self-hosted recovery with no Conductor: stable executor ids, a pinned version, DBOS.patch, resumeWorkflow.
describe('on-prem recovery without Conductor', () => {
  let lt: Harness;

  const pendingRow = (workflowId: string) => eventually(async () => {
    const data = await api<any>('GET', `/api/escalations/by-workflow/${workflowId}`, lt.adminToken);
    const rows = Array.isArray(data) ? data : data.escalations;
    return rows.find((r: { status: string }) => r.status === 'pending') as { id: string } | undefined;
  }, `escalation for ${workflowId}`);
  const resolve = (id: string, payload: Record<string, unknown>) => api('POST', `/api/escalations/${id}/resolve`, lt.adminToken, { resolverPayload: payload });
  const restart = async (identity = REPLICA) => {
    await DBOS.shutdown();
    await launchDbos(identity);
  };

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();
  });

  afterAll(async () => {
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  it('a restarted replica with the same executor id and version recovers its parked wait', async () => {
    const id = `onprem-restart-${Date.now()}`;
    await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-r1');
    const row = await pendingRow(id);
    await restart();
    await resolve(row.id, { approved: true });
    await expect(DBOS.retrieveWorkflow(id).getResult()).resolves.toMatchObject({ status: 'shipped' });
  });

  it('a different application version leaves the wait parked until the pinned version runs again', async () => {
    const id = `onprem-version-${Date.now()}`;
    await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-r2');
    const row = await pendingRow(id);
    await restart({ ...REPLICA, applicationVersion: 'review-order-unpinned' });
    await resolve(row.id, { approved: true });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await DBOS.getWorkflowStatus(id))?.status).toBe('PENDING');
    await restart();
    await expect(DBOS.retrieveWorkflow(id).getResult()).resolves.toMatchObject({ status: 'shipped' });
  });

  it('DBOS.patch keeps waits parked under old code on the old path after a redeploy', async () => {
    deployed.revision = 1;
    const before = `onprem-patch-old-${Date.now()}`;
    await DBOS.startWorkflow(auditedReview, { workflowID: before })('order-p1');
    const oldRow = await pendingRow(before);

    deployed.revision = 2;
    await restart();
    await resolve(oldRow.id, { approved: true });
    await expect(DBOS.retrieveWorkflow(before).getResult()).resolves.toEqual({ orderId: 'order-p1', approved: true, audited: false });

    const after = `onprem-patch-new-${Date.now()}`;
    const handle = await DBOS.startWorkflow(auditedReview, { workflowID: after })('order-p2');
    await resolve((await pendingRow(after)).id, { approved: true });
    await expect(handle.getResult()).resolves.toEqual({ orderId: 'order-p2', approved: true, audited: true });
    const names = ((await DBOS.listWorkflowSteps(after)) ?? []).map((s) => s.name);
    expect(names).toContain('audit');
  });

  it('a retired replica\'s parked wait is adopted with resumeWorkflow', async () => {
    const id = `onprem-retired-${Date.now()}`;
    await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-r3');
    const row = await pendingRow(id);

    // replica-a is retired; replica-b starts and does not recover replica-a's work on its own.
    await restart({ ...REPLICA, executorID: 'replica-b' });
    const orphaned = await DBOS.listWorkflows({ status: 'PENDING', executorId: 'replica-a' });
    expect(orphaned.map((w) => w.workflowID)).toContain(id);

    const handle = await DBOS.resumeWorkflow<any>(id);
    await resolve(row.id, { approved: true });
    await expect(handle.getResult()).resolves.toMatchObject({ status: 'shipped' });
    expect((await DBOS.getWorkflowStatus(id))?.executorId).toBe('replica-b');
  });
});
