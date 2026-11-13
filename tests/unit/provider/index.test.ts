import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk';

import { createDbosProvider, dbosProvider } from '../../../src/provider';
import run from '../../fixtures/dbos-run.json';

const REF = { provider: 'dbos', workflowId: 'wf-1', runScope: '', waitKey: 'review' };
const OUTCOME = { waitKey: 'review', escalationId: 'e-1', status: 'resolved' as const, data: { approved: true } };

describe('DBOS provider', () => {
  const client = {
    getWorkflow: vi.fn(),
    listWorkflowSteps: vi.fn(),
    send: vi.fn(),
    enqueue: vi.fn(),
    cancelWorkflow: vi.fn(),
    destroy: vi.fn(),
  };
  const provider = createDbosProvider(client as any);

  beforeEach(() => {
    vi.clearAllMocks();
    client.getWorkflow.mockResolvedValue({ workflowID: 'wf-1', status: 'PENDING', workflowName: 'reviewOrder', createdAt: 0 });
  });

  it('is a non-native provider that starts, exports and terminates, and does not list without a counter', () => {
    expect(provider.name).toBe('dbos');
    expect(provider.capabilities).toEqual({ native: false, execution: true, terminate: true, list: false, start: true });
    expect(provider.list).toBeUndefined();
  });

  it('starts a workflow by enqueueing it on the config queue with the envelope', async () => {
    const envelope = { data: { orderId: '42' }, metadata: {}, lt: { userId: 'u-1' } };
    await provider.start!({ workflowType: 'reviewOrderRequest', workflowId: 'review-42', taskQueue: 'orders', args: [envelope] });
    expect(client.enqueue).toHaveBeenCalledWith(
      { queueName: 'orders', workflowName: 'reviewOrderRequest', workflowID: 'review-42' },
      envelope,
    );
  });

  it('delivers to a waiting workflow on the wait key, keyed by escalation id', async () => {
    await expect(provider.deliver(REF, OUTCOME)).resolves.toBe('delivered');
    expect(client.send).toHaveBeenCalledWith('wf-1', OUTCOME, 'review', 'e-1');
  });

  it('reports gone for a finished or missing workflow without sending', async () => {
    client.getWorkflow.mockResolvedValueOnce({ status: 'SUCCESS' });
    await expect(provider.deliver(REF, OUTCOME)).resolves.toBe('gone');
    client.getWorkflow.mockResolvedValueOnce(undefined);
    await expect(provider.deliver(REF, OUTCOME)).resolves.toBe('gone');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('reports gone when the workflow disappears before the send', async () => {
    client.send.mockRejectedValueOnce(new DBOSErrors.DBOSNonExistentWorkflowError('gone'));
    await expect(provider.deliver(REF, OUTCOME)).resolves.toBe('gone');
  });

  it('throws a transient send failure so the relay retries', async () => {
    client.send.mockRejectedValueOnce(new Error('connection reset'));
    await expect(provider.deliver(REF, OUTCOME)).rejects.toThrow(/connection reset/);
  });

  it('describes through getWorkflow', async () => {
    await expect(provider.describe('wf-1')).resolves.toMatchObject({ workflowId: 'wf-1', state: 'running', providerState: 'PENDING' });
  });

  it('exports every page of steps', async () => {
    client.getWorkflow.mockResolvedValue(run.status);
    const page = Array.from({ length: 500 }, (_, i) => ({ functionID: i, name: `s${i}`, output: i, error: null, childWorkflowID: null, startedAtEpochMs: 1, completedAtEpochMs: 2 }));
    client.listWorkflowSteps.mockResolvedValueOnce(page).mockResolvedValueOnce(run.steps.slice(0, 2));
    const execution = await provider.export!('wf-1');
    expect(client.listWorkflowSteps).toHaveBeenNthCalledWith(1, 'wf-1', { limit: 500, offset: 0 });
    expect(client.listWorkflowSteps).toHaveBeenNthCalledWith(2, 'wf-1', { limit: 500, offset: 500 });
    expect(execution.summary.activities.total).toBe(502);
  });

  it('fails loud exporting a missing workflow', async () => {
    client.getWorkflow.mockResolvedValue(undefined);
    await expect(provider.export!('wf-x')).rejects.toThrow(/not found/);
  });

  it('terminates through cancelWorkflow and closes the client', async () => {
    await provider.terminate!('wf-1', 'reason');
    expect(client.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    await provider.close();
    expect(client.destroy).toHaveBeenCalled();
  });

  it('requires a system database url', async () => {
    await expect(dbosProvider({ systemDatabaseUrl: '' })).rejects.toThrow(/systemDatabaseUrl/);
  });
});
