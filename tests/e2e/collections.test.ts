import { describe, it, expect, beforeAll } from 'vitest';

import { LongTail, runId } from './stack';

// Batch and accumulate waits on DBOS, started from Long Tail and filled
// through its API, return what the same waits return on HotMesh.
describe('e2e: batch and accumulate waits on DBOS', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  async function invoke(workflow: string, data: Record<string, unknown>): Promise<string> {
    const { workflowId } = await admin.request<{ workflowId: string }>('POST', `/api/workflows/${workflow}/invoke`, { data, workflowId: data.orderId });
    return workflowId;
  }

  const fill = (id: string, itemKey: string, resolverPayload: Record<string, unknown>) =>
    admin.request('POST', `/api/escalations/${id}/resolve-batch-item`, { itemKey, resolverPayload });
  const add = (id: string, approver: string) =>
    admin.request('POST', `/api/escalations/${id}/accumulate`, { itemKey: approver, payload: { approver } });

  it('fills one escalation per side and returns both sides', async () => {
    const orderId = runId('inspect');
    const workflowId = await invoke('inspectOrderRequest', { orderId });
    const row = await admin.pendingEscalation(workflowId);
    expect(row.metadata).toMatchObject({ orderId, batch_pending: ['left', 'right'] });

    await fill(row.id, 'left', { passed: true });
    expect((await admin.escalationsFor(workflowId))[0].status).toBe('pending');
    await fill(row.id, 'right', { passed: false });

    const execution = await admin.closedExecution(workflowId);
    expect(execution.result).toEqual({ data: { orderId, sides: { left: { passed: true }, right: { passed: false } } } });
  });

  it('returns the sides inspected so far when the deadline passes', async () => {
    const orderId = runId('inspect-partial');
    const workflowId = await invoke('inspectOrderRequest', { orderId, timeout: '2s' });
    const row = await admin.pendingEscalation(workflowId);
    await fill(row.id, 'left', { passed: true });

    const execution = await admin.closedExecution(workflowId, 60_000);
    expect(execution.result).toEqual({ data: { orderId, sides: { left: { passed: true }, $trigger: 'timeout' } } });
    expect((await admin.escalationsFor(workflowId))[0].status).toBe('expired');
  });

  it('collects approvals until the count is reached', async () => {
    const orderId = runId('approvals');
    const workflowId = await invoke('collectApprovalsRequest', { orderId, approvals: 2 });
    const row = await admin.pendingEscalation(workflowId);
    await add(row.id, 'ana');
    await add(row.id, 'ben');

    const execution = await admin.closedExecution(workflowId);
    expect(execution.result).toEqual({ data: { orderId, trigger: 'count', approvers: ['ana', 'ben'] } });
  });

  it('returns the approvals so far when the deadline passes', async () => {
    const orderId = runId('approvals-timeout');
    const workflowId = await invoke('collectApprovalsRequest', { orderId, approvals: 5, timeout: '2s' });
    const row = await admin.pendingEscalation(workflowId);
    await add(row.id, 'ana');

    const execution = await admin.closedExecution(workflowId, 60_000);
    expect(execution.result).toEqual({ data: { orderId, trigger: 'timeout', approvers: ['ana'] } });
  });

  it('returns the approvals with the resolver payload when a person closes it', async () => {
    const orderId = runId('approvals-resolve');
    const workflowId = await invoke('collectApprovalsRequest', { orderId, approvals: 5 });
    const row = await admin.pendingEscalation(workflowId);
    await add(row.id, 'ana');
    await admin.resolve(row.id, { closedBy: 'lead' });

    const execution = await admin.closedExecution(workflowId);
    expect(execution.result).toEqual({ data: { orderId, trigger: 'resolve', approvers: ['ana'] } });
  });
});
