import { describe, it, expect, beforeAll } from 'vitest';

import { LongTail, eventually, runId, startReview } from './stack';

// The relay sweep (30 s by default) delivers expiries, so that test allows a full sweep.
const SWEEP_MS = Number(process.env.LT_RELAY_SWEEP_MS ?? 30_000);

describe('e2e: outcomes other than a resolve', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  it('a cancelled escalation returns null to the workflow', async () => {
    const workflowId = await startReview(runId('cancel'));
    const row = await admin.pendingEscalation(workflowId);
    await admin.request('POST', `/api/escalations/${row.id}/cancel`, {});

    const execution = await admin.closedExecution(workflowId);
    expect(execution.result).toEqual({ orderId: expect.any(String), status: 'cancelled' });
    expect((await admin.escalationsFor(workflowId))[0].status).toBe('cancelled');
  });

  it('an escalation past its SLA expires and returns false to the workflow', async () => {
    const workflowId = await startReview(runId('expire'), '1s');
    await admin.pendingEscalation(workflowId);

    const execution = await admin.closedExecution(workflowId, SWEEP_MS + 20_000);
    expect(execution.result).toMatchObject({ status: 'expired' });
    expect((await admin.escalationsFor(workflowId))[0].status).toBe('expired');
  });

  it('terminating the workflow stops it in DBOS and cancels its open escalation', async () => {
    const workflowId = await startReview(runId('terminate'));
    const row = await admin.pendingEscalation(workflowId);

    await admin.request('POST', `/api/workflows/${workflowId}/terminate`, { reason: 'e2e' });

    const described = await eventually(async () => {
      const status = await admin.request<{ state: string; providerState: string }>('GET', `/api/workflows/${workflowId}/describe`);
      return status.state === 'running' ? undefined : status;
    }, 'terminated');
    expect(described.providerState).toBe('CANCELLED');
    const after = await eventually(async () => (await admin.escalationsFor(workflowId)).find((r) => r.id === row.id && r.status !== 'pending'), 'escalation closed');
    expect(after.status).toBe('cancelled');
  });

  it('resolving an escalation twice is refused and the workflow sees one outcome', async () => {
    const workflowId = await startReview(runId('twice'));
    const row = await admin.pendingEscalation(workflowId);
    await admin.resolve(row.id, { approved: true, notes: 'first' });

    const second = await admin.send('POST', `/api/escalations/${row.id}/resolve`, { resolverPayload: { approved: false, notes: 'second' } });
    expect(second.status).toBeGreaterThanOrEqual(400);

    const execution = await admin.closedExecution(workflowId);
    expect(execution.result).toMatchObject({ status: 'shipped', decision: { notes: 'first' } });
  });
});
