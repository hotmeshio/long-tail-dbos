import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { conditional, conditionalOutcome, type LTConditionalConfig } from '../../src';
import { api, deliveryOf, launchDbos, pendingRow, recreateDatabases, startLongTail, type Harness } from './harness';

// A wait opened with signalKey is addressed by key, as a HotMesh escalation is.
const ask = (key: string, extra: Partial<LTConditionalConfig> = {}): LTConditionalConfig =>
  ({ role: 'reviewer', type: 'order-review', metadata: { orderId: key }, signalKey: key, ...extra });

async function outcomeFn(key: string) {
  return conditionalOutcome(key, ask(key));
}
const outcomeWait = DBOS.registerWorkflow(outcomeFn, { name: 'outcomeBySignalKey' });

async function provenanceFn(key: string) {
  return conditional(key, ask(key, { withResolution: true }));
}
const provenanceWait = DBOS.registerWorkflow(provenanceFn, { name: 'provenanceBySignalKey' });

async function collectFn(key: string) {
  return conditionalOutcome(key, ask(key, { accumulate: { max: 2 } }));
}
const collectWait = DBOS.registerWorkflow(collectFn, { name: 'collectBySignalKey' });

describe('Long Tail on DBOS: signal keys and whole outcomes', () => {
  let lt: Harness;
  const bySignalKey = (signalKey: string, resolverPayload: Record<string, unknown>) =>
    api('POST', '/api/escalations/resolve-by-signal-key', lt.adminToken, { signalKey, resolverPayload });
  const isoNear = (iso: string | null) => Math.abs(Date.parse(iso ?? '') - Date.now()) < 60_000;

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();
  });

  afterAll(async () => {
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  it('resolve-by-signal-key delivers the whole outcome to conditionalOutcome', async () => {
    const key = `sk-outcome-${Date.now()}`;
    const handle = await DBOS.startWorkflow(outcomeWait, { workflowID: key })(key);
    const row = await pendingRow(key, lt.adminToken);

    await bySignalKey(key, { approved: true, notes: 'by key' });

    const outcome = await handle.getResult();
    expect(outcome).toMatchObject({ status: 'resolved', data: { approved: true, notes: 'by key' }, escalationId: row.id, resolvedBy: lt.adminUserId });
    expect(isoNear(outcome.resolvedAt)).toBe(true);
  });

  it('conditional with withResolution returns $resolution beside the payload', async () => {
    const key = `sk-provenance-${Date.now()}`;
    const handle = await DBOS.startWorkflow(provenanceWait, { workflowID: key })(key);
    const row = await pendingRow(key, lt.adminToken);

    await bySignalKey(key, { approved: false });

    await expect(handle.getResult()).resolves.toEqual({
      approved: false, $resolution: { escalationId: row.id, resolvedBy: lt.adminUserId, resolvedAt: expect.any(String) },
    });
  });

  it('accumulate-by-signal-key fills an accumulator to its max, and items-by-signal-key reads it', async () => {
    const key = `sk-collect-${Date.now()}`;
    const handle = await DBOS.startWorkflow(collectWait, { workflowID: key })(key);
    await pendingRow(key, lt.adminToken);

    await api('POST', '/api/escalations/accumulate-by-signal-key', lt.adminToken, { signalKey: key, itemKey: 'ana', payload: { approver: 'ana' } });
    const items = await api<unknown>('GET', `/api/escalations/items-by-signal-key?signalKey=${encodeURIComponent(key)}`, lt.adminToken);
    expect(JSON.stringify(items)).toContain('ana');
    await api('POST', '/api/escalations/accumulate-by-signal-key', lt.adminToken, { signalKey: key, itemKey: 'ben', payload: { approver: 'ben' } });

    const outcome = await handle.getResult();
    expect(outcome.status).toBe('resolved');
    expect(outcome.data).toMatchObject({ $trigger: 'count', $accumulated: [{ itemKey: 'ana' }, { itemKey: 'ben' }] });
  });

  it('a whole outcome resolved by key while the DBOS process is down arrives after the restart', async () => {
    const key = `sk-restart-${Date.now()}`;
    await DBOS.startWorkflow(outcomeWait, { workflowID: key })(key);
    const row = await pendingRow(key, lt.adminToken);

    await DBOS.shutdown();
    await bySignalKey(key, { approved: true, notes: 'while down' });
    expect(await deliveryOf(row.id)).toBe('delivered');
    await launchDbos();

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toMatchObject({
      status: 'resolved', data: { approved: true, notes: 'while down' }, escalationId: row.id, resolvedBy: lt.adminUserId,
    });
  });

  it('a cancelled wait is a cancelled outcome with no data', async () => {
    const key = `sk-cancel-${Date.now()}`;
    const handle = await DBOS.startWorkflow(outcomeWait, { workflowID: key })(key);
    const row = await pendingRow(key, lt.adminToken);

    await api('POST', `/api/escalations/${row.id}/cancel`, lt.adminToken, {});

    await expect(handle.getResult()).resolves.toMatchObject({ status: 'cancelled', data: null, escalationId: row.id });
  });
});
