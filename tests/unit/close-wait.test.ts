import { describe, it, expect, vi, beforeEach } from 'vitest';

// At the recv deadline, lt.close returns the row's own outcome: one Long Tail
// committed but has not delivered, or the cancel it makes on a pending row.
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { registerStep: (fn: unknown) => fn },
  Error: { DBOSConflictingRegistrationError: class extends Error {} },
}));
vi.mock('../../src/lt-client', () => ({ requestOpenWait: vi.fn(), requestCancel: vi.fn(), requestEscalation: vi.fn() }));

import { closeWait } from '../../src/steps';
import { requestEscalation, requestCancel } from '../../src/lt-client';

const AT = '2026-11-13T10:00:00.000Z';
const row = (status: string, extra: Record<string, unknown> = {}) => ({ status, updated_at: AT, ...extra });

describe('lt.close at the recv deadline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a resolved outcome that was not delivered, without cancelling', async () => {
    (requestEscalation as any).mockResolvedValueOnce(row('resolved', { resolver_payload: '{"approved":true}', resolved_by: 'u-1', resolved_at: AT }));
    await expect(closeWait('e-1', 'review')).resolves.toEqual({
      waitKey: 'review', escalationId: 'e-1', status: 'resolved', data: { approved: true }, resolvedBy: 'u-1', resolvedAt: AT,
    });
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it('returns an expired outcome with the collection the expiry kept', async () => {
    const kept = { $accumulated: [], $trigger: 'timeout' };
    (requestEscalation as any).mockResolvedValueOnce(row('expired', { resolver_payload: kept }));
    await expect(closeWait('e-1', 'approvals')).resolves.toMatchObject({ status: 'expired', data: kept });
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it('cancels a pending row and reports it cancelled', async () => {
    (requestEscalation as any).mockResolvedValueOnce(row('pending')).mockResolvedValueOnce(row('cancelled'));
    await expect(closeWait('e-1', 'review')).resolves.toEqual({ waitKey: 'review', escalationId: 'e-1', status: 'cancelled', resolvedAt: AT });
    expect(requestCancel).toHaveBeenCalledWith('e-1');
  });

  it('returns the resolve that won the race with the cancel', async () => {
    (requestEscalation as any)
      .mockResolvedValueOnce(row('pending'))
      .mockResolvedValueOnce(row('resolved', { resolver_payload: { approved: false } }));
    await expect(closeWait('e-1', 'review')).resolves.toMatchObject({ status: 'resolved', data: { approved: false } });
    expect(requestCancel).toHaveBeenCalledWith('e-1');
  });

  it('throws so the step retries when the row is still pending after the cancel', async () => {
    (requestEscalation as any).mockResolvedValue(row('pending'));
    await expect(closeWait('e-1', 'review')).rejects.toThrow(/still pending after cancel/);
  });

  it('throws when Long Tail cannot be read, so the step retries', async () => {
    (requestEscalation as any).mockRejectedValueOnce(new Error('Long Tail GET /api/escalations/e-1 failed'));
    await expect(closeWait('e-1', 'review')).rejects.toThrow(/failed/);
    expect(requestCancel).not.toHaveBeenCalled();
  });
});
