import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbos = vi.hoisted(() => ({
  inWorkflow: true,
  recv: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    isInWorkflow: () => dbos.inWorkflow,
    recv: dbos.recv,
    get logger() { return { warn: dbos.warn }; },
  },
}));
vi.mock('../../src/steps', () => ({ ltOpen: vi.fn(), ltClose: vi.fn() }));

import { conditional, waitSeconds } from '../../src/conditional';
import { ltClose, ltOpen } from '../../src/steps';
import { WAIT_DEFAULTS } from '../../src/constants';

const CONFIG = { role: 'reviewer', type: 'order-review', timeout: '1h' };

describe('conditional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbos.inWorkflow = true;
    (ltOpen as any).mockResolvedValue({ escalationId: 'e-1', waitKey: 'review', status: 'pending', expiresAt: null, workflowType: 'reviewOrder' });
  });

  it('opens, waits on the key, and returns the resolver payload', async () => {
    dbos.recv.mockResolvedValue({ waitKey: 'review', escalationId: 'e-1', status: 'resolved', data: { approved: true } });
    await expect(conditional('review', CONFIG)).resolves.toEqual({ approved: true });
    expect(ltOpen).toHaveBeenCalledWith('review', CONFIG);
    expect(dbos.recv).toHaveBeenCalledWith('review', { timeoutSeconds: 3600 + WAIT_DEFAULTS.GRACE_SECONDS });
  });

  it('returns null for expired and cancelled outcomes', async () => {
    dbos.recv.mockResolvedValueOnce({ waitKey: 'review', escalationId: 'e-1', status: 'expired' });
    await expect(conditional('review', CONFIG)).resolves.toBeNull();
    dbos.recv.mockResolvedValueOnce({ waitKey: 'review', escalationId: 'e-1', status: 'cancelled' });
    await expect(conditional('review', CONFIG)).resolves.toBeNull();
    expect(ltClose).not.toHaveBeenCalled();
  });

  it('returns the collection an expiry kept', async () => {
    const kept = { $accumulated: [{ itemKey: 'ana', at: '2026-11-13T00:00:00.000Z' }], $trigger: 'timeout' };
    dbos.recv.mockResolvedValueOnce({ waitKey: 'review', escalationId: 'e-1', status: 'expired', data: kept });
    await expect(conditional('review', { ...CONFIG, accumulate: { max: 3 } })).resolves.toEqual(kept);
  });

  it('settles from the row when the recv deadline passes first', async () => {
    dbos.recv.mockResolvedValue(null);
    (ltClose as any).mockResolvedValueOnce({ waitKey: 'review', escalationId: 'e-1', status: 'cancelled' });
    await expect(conditional('review', CONFIG)).resolves.toBeNull();
    expect(ltClose).toHaveBeenCalledWith('e-1', 'review');
  });

  it('returns an outcome Long Tail committed but had not delivered by the deadline', async () => {
    dbos.recv.mockResolvedValue(null);
    (ltClose as any).mockResolvedValueOnce({ waitKey: 'review', escalationId: 'e-1', status: 'resolved', data: { approved: true } });
    await expect(conditional('review', CONFIG)).resolves.toEqual({ approved: true });
    (ltClose as any).mockResolvedValueOnce({ waitKey: 'review', escalationId: 'e-1', status: 'expired', data: { $trigger: 'timeout' } });
    await expect(conditional('review', CONFIG)).resolves.toEqual({ $trigger: 'timeout' });
  });

  it('returns null when a step recorded by an earlier version replays with no outcome', async () => {
    dbos.recv.mockResolvedValue(null);
    (ltClose as any).mockResolvedValueOnce(undefined);
    await expect(conditional('review', CONFIG)).resolves.toBeNull();
  });

  it('returns an empty object when resolved without data', async () => {
    dbos.recv.mockResolvedValue({ waitKey: 'review', escalationId: 'e-1', status: 'resolved' });
    await expect(conditional('review', CONFIG)).resolves.toEqual({});
  });

  it('fails loud on missing key, role or type, or outside a workflow body', async () => {
    await expect(conditional('', CONFIG)).rejects.toThrow(/key is required/);
    await expect(conditional('k', { role: '', type: 't' })).rejects.toThrow(/role and type/);
    dbos.inWorkflow = false;
    await expect(conditional('k', CONFIG)).rejects.toThrow(/workflow body/);
    expect(ltOpen).not.toHaveBeenCalled();
  });
});

describe('waitSeconds', () => {
  it('adds the grace period to the SLA', () => {
    expect(waitSeconds({ role: 'r', type: 't', timeout: 90_000 })).toBe(90 + WAIT_DEFAULTS.GRACE_SECONDS);
  });

  it('uses maxWaitSeconds, else a year, without an SLA', () => {
    expect(waitSeconds({ role: 'r', type: 't', maxWaitSeconds: 120 })).toBe(120);
    expect(waitSeconds({ role: 'r', type: 't' })).toBe(WAIT_DEFAULTS.MAX_WAIT_SECONDS);
  });
});
