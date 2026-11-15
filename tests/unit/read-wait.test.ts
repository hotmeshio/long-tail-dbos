import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { registerStep: (fn: unknown) => fn },
  Error: { DBOSConflictingRegistrationError: class extends Error {} },
}));
vi.mock('../../src/lt-client', () => ({ requestOpenWait: vi.fn(), requestCancel: vi.fn(), requestEscalation: vi.fn() }));

import { readWait } from '../../src/steps';
import { requestEscalation, requestCancel } from '../../src/lt-client';

const AT = '2026-11-13T10:00:00.000Z';
const row = (status: string, extra: Record<string, unknown> = {}) => ({ status, updated_at: AT, ...extra });

describe('lt.read between parks of a wait with no deadline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null while the row is pending and leaves it open', async () => {
    (requestEscalation as any).mockResolvedValueOnce(row('pending'));
    await expect(readWait('e-1', 'review')).resolves.toBeNull();
    expect(requestCancel).not.toHaveBeenCalled();
  });

  it('returns a resolved outcome with its payload and resolver', async () => {
    (requestEscalation as any).mockResolvedValueOnce(row('resolved', { resolver_payload: '{"approved":true}', resolved_by: 'u-1', resolved_at: AT }));
    await expect(readWait('e-1', 'review')).resolves.toEqual({
      waitKey: 'review', escalationId: 'e-1', status: 'resolved', data: { approved: true }, resolvedBy: 'u-1', resolvedAt: AT,
    });
  });

  it('returns a cancelled outcome without data', async () => {
    (requestEscalation as any).mockResolvedValueOnce(row('cancelled', { resolver_payload: { stale: true } }));
    await expect(readWait('e-1', 'review')).resolves.toEqual({ waitKey: 'review', escalationId: 'e-1', status: 'cancelled', resolvedAt: AT });
  });

  it('throws when Long Tail cannot be read, so the step retries', async () => {
    (requestEscalation as any).mockRejectedValueOnce(new Error('Long Tail GET /api/escalations/e-1 failed'));
    await expect(readWait('e-1', 'review')).rejects.toThrow(/failed/);
  });
});
