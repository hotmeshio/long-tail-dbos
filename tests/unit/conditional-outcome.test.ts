import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbos = vi.hoisted(() => ({ recv: vi.fn(), warn: vi.fn() }));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    isInWorkflow: () => true,
    recv: dbos.recv,
    get logger() { return { warn: dbos.warn }; },
  },
}));
vi.mock('../../src/steps', () => ({ ltOpen: vi.fn(), ltClose: vi.fn() }));

import { conditional, conditionalOutcome } from '../../src/conditional';
import { ltClose, ltOpen } from '../../src/steps';

const CONFIG = { role: 'reviewer', type: 'order-review', timeout: '1h' };
const AT = '2026-11-13T10:00:00.000Z';
const delivered = (status: string, extra: Record<string, unknown> = {}) => ({ waitKey: 'review', escalationId: 'e-1', status, ...extra });

describe('conditionalOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ltOpen as any).mockResolvedValue({ escalationId: 'e-1', waitKey: 'review', status: 'pending', expiresAt: null, workflowType: 'reviewOrder' });
  });

  it('returns a resolve with its data, escalation, resolver and time', async () => {
    dbos.recv.mockResolvedValueOnce(delivered('resolved', { data: { approved: true }, resolvedBy: 'u-1', resolvedAt: AT }));
    await expect(conditionalOutcome('review', CONFIG)).resolves.toEqual({
      status: 'resolved', data: { approved: true }, escalationId: 'e-1', resolvedBy: 'u-1', resolvedAt: AT,
    });
  });

  it('returns an empty object for a resolve without data', async () => {
    dbos.recv.mockResolvedValueOnce(delivered('resolved'));
    await expect(conditionalOutcome('review', CONFIG)).resolves.toEqual({
      status: 'resolved', data: {}, escalationId: 'e-1', resolvedBy: null, resolvedAt: null,
    });
  });

  it('returns an expiry with no data', async () => {
    dbos.recv.mockResolvedValueOnce(delivered('expired', { resolvedAt: AT }));
    await expect(conditionalOutcome('review', CONFIG)).resolves.toEqual({
      status: 'expired', data: null, escalationId: 'e-1', resolvedBy: null, resolvedAt: AT,
    });
  });

  it('returns the collection an expired accumulator kept', async () => {
    const kept = { $accumulated: [{ itemKey: 'ana', at: AT }], $trigger: 'timeout' };
    dbos.recv.mockResolvedValueOnce(delivered('expired', { data: kept }));
    await expect(conditionalOutcome('review', { ...CONFIG, accumulate: {} })).resolves.toMatchObject({ status: 'expired', data: kept });
  });

  it('returns a cancel with no data, even when the row carries one', async () => {
    dbos.recv.mockResolvedValueOnce(delivered('cancelled', { data: { stale: true }, resolvedBy: 'u-2', resolvedAt: AT }));
    await expect(conditionalOutcome('review', CONFIG)).resolves.toEqual({
      status: 'cancelled', data: null, escalationId: 'e-1', resolvedBy: 'u-2', resolvedAt: AT,
    });
  });

  it('settles from the row at the recv deadline, with the same shape', async () => {
    dbos.recv.mockResolvedValue(null);
    (ltClose as any).mockResolvedValueOnce(delivered('resolved', { data: { approved: false }, resolvedBy: 'u-3', resolvedAt: AT }));
    await expect(conditionalOutcome('review', CONFIG)).resolves.toEqual({
      status: 'resolved', data: { approved: false }, escalationId: 'e-1', resolvedBy: 'u-3', resolvedAt: AT,
    });
    expect(ltClose).toHaveBeenCalledWith('e-1', 'review');
    expect(dbos.warn).toHaveBeenCalledWith(expect.stringMatching(/recv deadline/));

    (ltClose as any).mockResolvedValueOnce(delivered('cancelled', { resolvedAt: AT }));
    await expect(conditionalOutcome('review', CONFIG)).resolves.toMatchObject({ status: 'cancelled', data: null });
  });

  it('reads a close step recorded by an earlier version as a cancel of the opened escalation', async () => {
    dbos.recv.mockResolvedValue(null);
    (ltClose as any).mockResolvedValueOnce(undefined);
    await expect(conditionalOutcome('review', CONFIG)).resolves.toEqual({
      status: 'cancelled', data: null, escalationId: 'e-1', resolvedBy: null, resolvedAt: null,
    });
  });

  it('fails loud on an invalid priority, schemaVersion or durationMinutes before opening anything', async () => {
    await expect(conditionalOutcome('k', { ...CONFIG, priority: 5 })).rejects.toThrow(/priority must be 1, 2, 3 or 4/);
    await expect(conditionalOutcome('k', { ...CONFIG, schemaVersion: 0 })).rejects.toThrow(/schemaVersion/);
    await expect(conditionalOutcome('k', { ...CONFIG, schemaVersion: 1.5 })).rejects.toThrow(/schemaVersion/);
    await expect(conditionalOutcome('k', { ...CONFIG, durationMinutes: 10 })).rejects.toThrow(/requires assignee/);
    await expect(conditionalOutcome('k', { ...CONFIG, assignee: 'u-1', durationMinutes: -1 })).rejects.toThrow(/positive number/);
    expect(ltOpen).not.toHaveBeenCalled();
  });
});

describe('conditional over conditionalOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ltOpen as any).mockResolvedValue({ escalationId: 'e-1', waitKey: 'review', status: 'pending', expiresAt: null, workflowType: 'reviewOrder' });
  });

  it('adds $resolution to a resolved payload when asked', async () => {
    dbos.recv.mockResolvedValueOnce(delivered('resolved', { data: { approved: true }, resolvedBy: 'u-1', resolvedAt: AT }));
    await expect(conditional('review', { ...CONFIG, withResolution: true })).resolves.toEqual({
      approved: true, $resolution: { escalationId: 'e-1', resolvedBy: 'u-1', resolvedAt: AT },
    });
  });

  it('leaves the payload as resolved without withResolution', async () => {
    dbos.recv.mockResolvedValueOnce(delivered('resolved', { data: { approved: true }, resolvedBy: 'u-1', resolvedAt: AT }));
    await expect(conditional('review', CONFIG)).resolves.toEqual({ approved: true });
  });

  it('adds no $resolution to an expired collection or a cancel', async () => {
    const kept = { $accumulated: [], $trigger: 'timeout' };
    dbos.recv.mockResolvedValueOnce(delivered('expired', { data: kept }));
    await expect(conditional('review', { ...CONFIG, withResolution: true })).resolves.toEqual(kept);
    dbos.recv.mockResolvedValueOnce(delivered('cancelled'));
    await expect(conditional('review', { ...CONFIG, withResolution: true })).resolves.toBeNull();
  });

  it('adds $resolution at the recv-deadline settle too', async () => {
    dbos.recv.mockResolvedValue(null);
    (ltClose as any).mockResolvedValueOnce(delivered('resolved', { data: { ok: 1 }, resolvedBy: 'u-9', resolvedAt: AT }));
    await expect(conditional('review', { ...CONFIG, withResolution: true })).resolves.toEqual({
      ok: 1, $resolution: { escalationId: 'e-1', resolvedBy: 'u-9', resolvedAt: AT },
    });
  });
});
