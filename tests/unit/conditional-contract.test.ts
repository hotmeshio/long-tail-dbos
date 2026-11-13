import { describe, it, expect, vi, beforeEach } from 'vitest';

// conditional() returns what HotMesh's conditional() returns, row for row.
const dbos = vi.hoisted(() => ({ recv: vi.fn() }));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { isInWorkflow: () => true, recv: dbos.recv, logger: { warn: vi.fn() } },
}));
vi.mock('../../src/steps', () => ({ ltOpen: vi.fn(), ltClose: vi.fn() }));

import { conditional } from '../../src/conditional';
import { ltClose, ltOpen } from '../../src/steps';

const CONFIG = { role: 'reviewer', type: 'order-review', timeout: '1h' };
const AT = '2026-11-13T00:00:00.000Z';
const outcome = (status: string, extra: Record<string, unknown> = {}) => ({ waitKey: 'w', escalationId: 'e-1', status, ...extra });

describe('the conditional() contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ltOpen as any).mockResolvedValue({ escalationId: 'e-1', waitKey: 'w', status: 'pending', expiresAt: null, workflowType: 'wf' });
  });

  it('returns the payload when resolved', async () => {
    dbos.recv.mockResolvedValueOnce(outcome('resolved', { data: { approved: true } }));
    await expect(conditional('w', CONFIG)).resolves.toEqual({ approved: true });
  });

  it('returns the payload with $resolution when resolved withResolution', async () => {
    dbos.recv.mockResolvedValueOnce(outcome('resolved', { data: { approved: true }, resolvedBy: 'u-1', resolvedAt: AT }));
    await expect(conditional('w', { ...CONFIG, withResolution: true })).resolves.toEqual({
      approved: true, $resolution: { escalationId: 'e-1', resolvedBy: 'u-1', resolvedAt: AT },
    });
  });

  it('returns false when a plain wait expires', async () => {
    dbos.recv.mockResolvedValueOnce(outcome('expired'));
    await expect(conditional('w', CONFIG)).resolves.toBe(false);
  });

  it('returns false when a batch without partialOnTimeout expires', async () => {
    dbos.recv.mockResolvedValueOnce(outcome('expired', { data: null }));
    await expect(conditional('w', { ...CONFIG, batch: ['left', 'right'] })).resolves.toBe(false);
  });

  it('returns the collection when an accumulator expires', async () => {
    const kept = { $accumulated: [{ itemKey: 'ana', payload: {}, at: AT }], $trigger: 'timeout' };
    dbos.recv.mockResolvedValueOnce(outcome('expired', { data: kept }));
    await expect(conditional('w', { ...CONFIG, accumulate: {} })).resolves.toEqual(kept);
  });

  it('returns the items so far when a partialOnTimeout batch expires', async () => {
    const kept = { left: { passed: true }, $trigger: 'timeout' };
    dbos.recv.mockResolvedValueOnce(outcome('expired', { data: kept }));
    await expect(conditional('w', { ...CONFIG, batch: ['left', 'right'], partialOnTimeout: true })).resolves.toEqual(kept);
  });

  it('returns null when cancelled, for a plain wait and an accumulator', async () => {
    dbos.recv.mockResolvedValueOnce(outcome('cancelled'));
    await expect(conditional('w', CONFIG)).resolves.toBeNull();
    dbos.recv.mockResolvedValueOnce(outcome('cancelled'));
    await expect(conditional('w', { ...CONFIG, accumulate: {} })).resolves.toBeNull();
  });

  it('returns false when the recv deadline settles an expired escalation', async () => {
    dbos.recv.mockResolvedValueOnce(null);
    (ltClose as any).mockResolvedValueOnce(outcome('expired'));
    await expect(conditional('w', CONFIG)).resolves.toBe(false);
  });
});
