import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { conditional, conditionalOutcome, type LTConditionalConfig } from '../../src';
import { api, launchDbos, pendingRow, recreateDatabases, startLongTail, type EscalationRow, type Harness } from './harness';

// What a DBOS wait carries beyond its queue and facets lands on the escalation as HotMesh writes it.
const BASE = { role: 'reviewer', type: 'order-review' };

async function askFn(key: string, extra: Partial<LTConditionalConfig>) {
  return conditional(key, { ...BASE, metadata: { orderId: key }, ...extra });
}
const ask = DBOS.registerWorkflow(askFn, { name: 'askWithFields' });

/** Two waits in a row: the second follows the first, by its escalation id. */
async function followUpFn(key: string) {
  const first = await conditionalOutcome(`${key}-first`, { ...BASE, type: 'first-look', metadata: { orderId: key } });
  const second = await conditionalOutcome(`${key}-second`, {
    ...BASE, type: 'second-look', metadata: { orderId: key }, parentId: first.escalationId, originId: first.escalationId,
  });
  return { first: first.escalationId, second: second.escalationId, data: second.data };
}
const followUp = DBOS.registerWorkflow(followUpFn, { name: 'followUp' });

const envelopeOf = (row: EscalationRow) => (typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope) ?? {};

describe('Long Tail on DBOS: what a wait carries', () => {
  let lt: Harness;
  const resolve = (id: string, payload: Record<string, unknown>) => api('POST', `/api/escalations/${id}/resolve`, lt.adminToken, { resolverPayload: payload });

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();
  });

  afterAll(async () => {
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  it('stores envelope form defaults, files, lookups and the schema version', async () => {
    const key = `fields-envelope-${Date.now()}`;
    const files = [{ path: 'orders/o-1/label.pdf', as: 'label', contentType: 'application/pdf' }];
    const lookups = [{ domain: 'orders', key: 'review-policy', as: 'policy' }];
    const handle = await DBOS.startWorkflow(ask, { workflowID: key })(key, {
      envelope: { formDefaults: { approved: true, notes: 'prefilled' } }, files, lookups, schemaVersion: 2,
    });

    const row = await pendingRow(key, lt.adminToken);
    expect(envelopeOf(row)).toMatchObject({ formDefaults: { approved: true, notes: 'prefilled' }, files, lookups });
    expect(row.metadata).toMatchObject({ orderId: key, schema_version: 2 });

    await resolve(row.id, { approved: true });
    await expect(handle.getResult()).resolves.toEqual({ approved: true });
  });

  it('claims the escalation for the assignee for durationMinutes', async () => {
    const key = `fields-claimed-${Date.now()}`;
    const before = Date.now();
    const handle = await DBOS.startWorkflow(ask, { workflowID: key })(key, { assignee: lt.adminUserId, durationMinutes: 30 });

    const row = await pendingRow(key, lt.adminToken);
    expect(row.assigned_to).toBe(lt.adminUserId);
    const until = Date.parse(row.assigned_until!);
    expect(until).toBeGreaterThan(before + 29 * 60_000);
    expect(until).toBeLessThan(Date.now() + 31 * 60_000);

    await resolve(row.id, { approved: false });
    await expect(handle.getResult()).resolves.toEqual({ approved: false });
  });

  it('assigns without a claim window when only the assignee is set', async () => {
    const key = `fields-assigned-${Date.now()}`;
    const handle = await DBOS.startWorkflow(ask, { workflowID: key })(key, { assignee: lt.adminUserId });

    const row = await pendingRow(key, lt.adminToken);
    expect(row.assigned_to).toBe(lt.adminUserId);
    expect(row.assigned_until).toBeNull();

    await resolve(row.id, { approved: true });
    await handle.getResult();
  });

  it('links a follow-up wait to the first by parent and origin', async () => {
    const key = `fields-lineage-${Date.now()}`;
    const handle = await DBOS.startWorkflow(followUp, { workflowID: key })(key);

    const first = await pendingRow(key, lt.adminToken, 'first-look');
    expect(first).toMatchObject({ parent_id: null });
    await resolve(first.id, { looked: true });

    const second = await pendingRow(key, lt.adminToken, 'second-look');
    expect(second).toMatchObject({ parent_id: first.id, origin_id: first.id });
    await resolve(second.id, { looked: 'again' });

    await expect(handle.getResult()).resolves.toEqual({ first: first.id, second: second.id, data: { looked: 'again' } });
  });
});
