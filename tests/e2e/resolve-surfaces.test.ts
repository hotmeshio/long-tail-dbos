import { describe, it, expect, beforeAll } from 'vitest';

import { LongTail, runId, startReview } from './stack';

// Every resolve surface delivers to the DBOS workflow the same way the dashboard's resolve does.
describe('e2e: resolve surfaces deliver to DBOS', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  it('resolve-by-ids resolves several waits and each workflow receives the payload', async () => {
    const workflowIds = await Promise.all([runId('ids-a'), runId('ids-b')].map((id) => startReview(id)));
    const rows = await Promise.all(workflowIds.map((id) => admin.pendingEscalation(id)));

    await admin.request('POST', '/api/escalations/resolve-by-ids', { ids: rows.map((r) => r.id), resolverPayload: { approved: true, notes: 'batch' } });

    for (const workflowId of workflowIds) {
      expect((await admin.closedExecution(workflowId)).result).toMatchObject({ status: 'shipped', decision: { notes: 'batch' } });
    }
  });

  it('resolve-by-metadata finds the wait by its orderId facet', async () => {
    const orderId = runId('meta');
    const workflowId = await startReview(orderId);
    await admin.pendingEscalation(workflowId);

    await admin.request('POST', '/api/escalations/resolve-by-metadata', { key: 'orderId', value: orderId, resolverPayload: { approved: true, notes: 'by facet' } });

    expect((await admin.closedExecution(workflowId)).result).toMatchObject({ status: 'shipped', decision: { notes: 'by facet' } });
  });

  it('bulk-cancel returns null to every workflow', async () => {
    const workflowIds = await Promise.all([runId('bulkc-a'), runId('bulkc-b')].map((id) => startReview(id)));
    const rows = await Promise.all(workflowIds.map((id) => admin.pendingEscalation(id)));

    await admin.request('POST', '/api/escalations/bulk-cancel', { ids: rows.map((r) => r.id) });

    for (const workflowId of workflowIds) {
      expect((await admin.closedExecution(workflowId)).result).toMatchObject({ status: 'cancelled' });
    }
  });
});
