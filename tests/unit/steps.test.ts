import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbos = vi.hoisted(() => {
  const registered: Array<Record<string, unknown>> = [];
  return {
    workflowID: 'wf-1' as string | undefined,
    getWorkflowStatus: vi.fn(),
    registered,
    registerStep: vi.fn((fn: unknown, config: Record<string, unknown>) => {
      registered.push(config);
      return fn;
    }),
  };
});
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    get workflowID() { return dbos.workflowID; },
    getWorkflowStatus: dbos.getWorkflowStatus,
    registerStep: dbos.registerStep,
  },
  Error: { DBOSConflictingRegistrationError: class extends Error {} },
}));
vi.mock('../../src/lt-client', () => ({ postOpenWait: vi.fn(), postCancel: vi.fn() }));

import { openWait, closeWait } from '../../src/steps';
import { postCancel, postOpenWait } from '../../src/lt-client';

describe('lt.open / lt.close steps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbos.workflowID = 'wf-1';
    dbos.getWorkflowStatus.mockResolvedValue({ workflowName: 'reviewOrder' });
    (postOpenWait as any).mockResolvedValue({ escalationId: 'e-1', status: 'pending', created: true });
  });

  it('registers both steps at import with retries', () => {
    expect(dbos.registered.map((c) => c.name)).toEqual(['lt.open', 'lt.close']);
    for (const config of dbos.registered) expect(config).toMatchObject({ retriesAllowed: true, maxAttempts: 10 });
  });

  it('opens the wait with the workflow id, type, key and SLA', async () => {
    const before = Date.now();
    const opened = await openWait('review', { role: 'reviewer', type: 'order-review', metadata: { orderId: 'o-1' }, timeout: '1h' });
    const body = (postOpenWait as any).mock.calls[0][0];
    expect(body).toMatchObject({ workflowId: 'wf-1', runScope: '', workflowType: 'reviewOrder', waitKey: 'review', role: 'reviewer', type: 'order-review', metadata: { orderId: 'o-1' } });
    const expires = Date.parse(body.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(opened).toEqual({ escalationId: 'e-1', waitKey: 'review', status: 'pending', expiresAt: body.expiresAt, workflowType: 'reviewOrder' });
  });

  it('omits expiresAt without an SLA', async () => {
    await openWait('review', { role: 'reviewer', type: 't' });
    expect((postOpenWait as any).mock.calls[0][0]).not.toHaveProperty('expiresAt');
  });

  it('sends a batch or accumulate declaration with only the fields set', async () => {
    const filled = { left: { payload: { passed: true }, at: '2026-11-13T00:00:00.000Z' } };
    await openWait('inspect', { role: 'reviewer', type: 't', batch: ['left', 'right'], filled, partialOnTimeout: true });
    const body = (postOpenWait as any).mock.calls[0][0];
    expect(body).toMatchObject({ batch: ['left', 'right'], filled, partialOnTimeout: true });
    expect(body).not.toHaveProperty('accumulate');
    expect(body).not.toHaveProperty('wakeOnFill');

    await openWait('approvals', { role: 'reviewer', type: 't', accumulate: { max: 2 } });
    expect((postOpenWait as any).mock.calls[1][0]).toMatchObject({ accumulate: { max: 2 } });
  });

  it('throws outside a workflow', async () => {
    dbos.workflowID = undefined;
    await expect(openWait('review', { role: 'r', type: 't' })).rejects.toThrow(/inside a DBOS workflow/);
  });

  it('closes by escalation id', async () => {
    await closeWait('e-9');
    expect(postCancel).toHaveBeenCalledWith('e-9');
  });
});

describe('registration after launch', () => {
  it('throws a clear error naming the import order', async () => {
    vi.resetModules();
    const { Error: errors } = await import('@dbos-inc/dbos-sdk') as any;
    dbos.registerStep.mockImplementationOnce(() => { throw new errors.DBOSConflictingRegistrationError('late'); });
    dbos.registered.length = 0;
    await expect(import('../../src/steps')).rejects.toThrow(/imported before DBOS.launch\(\)/);
  });
});
