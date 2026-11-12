import { describe, it, expect, vi, beforeEach } from 'vitest';

import { countWorkflowsSql, createDbosProvider, createWorkflowCounter, listFilter } from '../../../src/provider';

const row = (workflowID: string, status: string) => ({ workflowID, status, workflowName: 'reviewOrder', createdAt: Date.UTC(2026, 10, 11), completedAt: status === 'PENDING' ? undefined : Date.UTC(2026, 10, 11, 0, 5) });

describe('DBOS provider list', () => {
  const client = { getWorkflow: vi.fn(), listWorkflows: vi.fn(), listWorkflowSteps: vi.fn(), send: vi.fn(), cancelWorkflow: vi.fn(), destroy: vi.fn() };
  const counter = vi.fn();
  const provider = createDbosProvider(client as any, counter);

  beforeEach(() => {
    vi.clearAllMocks();
    client.listWorkflows.mockResolvedValue([row('review-2', 'PENDING'), row('review-1', 'CANCELLED')]);
    counter.mockResolvedValue(7);
  });

  it('lists with a counter', () => {
    expect(provider.capabilities.list).toBe(true);
  });

  it('pages newest first without payloads and reports the total', async () => {
    const page = await provider.list!({ limit: 2, offset: 4 });
    expect(client.listWorkflows).toHaveBeenCalledWith({ limit: 2, offset: 4, sortDesc: true, loadInput: false, loadOutput: false });
    expect(page.total).toBe(7);
    expect(page.workflows).toEqual([
      expect.objectContaining({ workflowId: 'review-2', workflowType: 'reviewOrder', state: 'running', providerState: 'PENDING' }),
      expect.objectContaining({ workflowId: 'review-1', state: 'cancelled', providerState: 'CANCELLED', closedAt: '2026-11-11T00:05:00.000Z' }),
    ]);
  });

  it('passes the same query to the list and the count', async () => {
    const query = { limit: 10, offset: 0, workflowType: 'reviewOrder', idPrefix: 'review-', state: 'failed' as const };
    await provider.list!(query);
    expect(client.listWorkflows).toHaveBeenCalledWith(expect.objectContaining({
      workflowName: 'reviewOrder', workflow_id_prefix: 'review-', status: ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'],
    }));
    expect(counter).toHaveBeenCalledWith(query);
  });
});

describe('listFilter', () => {
  it('maps running to every live DBOS status', () => {
    expect(listFilter({ limit: 1, offset: 0, state: 'running' })).toEqual({ status: ['PENDING', 'ENQUEUED', 'DELAYED', 'SUSPENDED'] });
  });

  it('is empty without filters', () => {
    expect(listFilter({ limit: 1, offset: 0 })).toEqual({});
  });
});

describe('createWorkflowCounter', () => {
  it('counts with name, statuses and prefix as parameters', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ total: 3 }] }) };
    const count = createWorkflowCounter(db);
    expect(await count({ limit: 1, offset: 0, workflowType: 'reviewOrder', state: 'completed', idPrefix: 'rev' })).toBe(3);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('"dbos".workflow_status'), ['reviewOrder', ['SUCCESS'], 'rev']);
  });

  it('passes nulls for absent filters', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ total: 0 }] }) };
    await createWorkflowCounter(db, 'custom_sys')({ limit: 1, offset: 0 });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('"custom_sys".workflow_status'), [null, null, null]);
  });

  it('refuses a schema name that is not an identifier', () => {
    expect(() => countWorkflowsSql('dbos"; drop table x; --')).toThrow(/schema name/);
  });
});
