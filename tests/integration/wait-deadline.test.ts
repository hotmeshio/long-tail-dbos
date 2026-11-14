import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { conditional, configureLongTail } from '../../src';
import { getLongTailConnection } from '../../src/config';
import { STEP } from '../../src/constants';
import { api, eventually, launchDbos, LT_DB, recreateDatabases, startLongTail, unreachableConnection, type Harness } from './harness';

// The recv deadline passes while an outcome Long Tail committed is still
// undelivered. Each test sets the database to that state: the row terminal,
// the wait marked delivered so the relay never sends it. The workflow must
// return the row's outcome, not null.
const DEADLINE_SECONDS = 3;

async function deadlineWaitFn(key: string, accumulate: boolean) {
  return conditional(key, {
    role: 'reviewer',
    type: 'deadline',
    metadata: { orderId: key },
    maxWaitSeconds: DEADLINE_SECONDS,
    ...(accumulate ? { accumulate: {} } : {}),
  });
}
const deadlineWait = DBOS.registerWorkflow(deadlineWaitFn, { name: 'deadlineWait' });

describe('settling a wait at the recv deadline', () => {
  let lt: Harness;
  let db: Client;

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();
    db = new Client({ host: 'localhost', port: Number(process.env.PG_PORT ?? 5425), user: 'postgres', password: 'password', database: LT_DB });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  async function startWait(key: string, accumulate = false): Promise<{ escalationId: string }> {
    await DBOS.startWorkflow(deadlineWait, { workflowID: key })(key, accumulate);
    return eventually(async () => {
      const { rows } = await db.query(`SELECT escalation_id AS "escalationId" FROM lt_durable_waits WHERE workflow_id = $1`, [key]);
      return rows[0];
    }, `wait for ${key}`);
  }

  /** The state the seam leaves: the row committed terminal, its delivery never made. */
  async function commitUndelivered(escalationId: string, status: string, payload: Record<string, unknown>): Promise<void> {
    await db.query('UPDATE lt_durable_waits SET delivered_at = NOW(), delivery = $2 WHERE escalation_id = $1', [escalationId, 'held-by-test']);
    await db.query(
      `UPDATE public.hmsh_escalations SET status = $2, resolver_payload = $3::jsonb, resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [escalationId, status, JSON.stringify(payload)],
    );
  }

  const statusOf = async (escalationId: string) =>
    (await db.query('SELECT status FROM public.hmsh_escalations WHERE id = $1', [escalationId])).rows[0].status;
  const stepNames = async (workflowId: string) => ((await DBOS.listWorkflowSteps(workflowId)) ?? []).map((s) => s.name);

  it('returns a resolve that Long Tail committed but never delivered', async () => {
    const key = `deadline-resolved-${Date.now()}`;
    const { escalationId } = await startWait(key);
    await commitUndelivered(escalationId, 'resolved', { approved: true });

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toEqual({ approved: true });
    expect(await statusOf(escalationId)).toBe('resolved');
    expect(await stepNames(key)).toContain(STEP.CLOSE);
  });

  it('returns the collection of an accumulator that expired undelivered', async () => {
    const key = `deadline-expired-${Date.now()}`;
    const { escalationId } = await startWait(key, true);
    await api('POST', `/api/escalations/${escalationId}/accumulate`, lt.adminToken, { itemKey: 'ana', payload: { approver: 'ana' } });
    const kept = { $accumulated: [{ itemKey: 'ana', payload: { approver: 'ana' }, at: new Date().toISOString() }], $trigger: 'timeout' };
    await commitUndelivered(escalationId, 'expired', kept);

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toEqual(kept);
  });

  it('returns false for a plain wait that expired undelivered', async () => {
    const key = `deadline-expired-plain-${Date.now()}`;
    const { escalationId } = await startWait(key);
    await db.query('UPDATE lt_durable_waits SET delivered_at = NOW(), delivery = $2 WHERE escalation_id = $1', [escalationId, 'held-by-test']);
    await db.query(`UPDATE public.hmsh_escalations SET status = 'expired', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`, [escalationId]);

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toBe(false);
  });

  it('cancels a row still pending at the deadline and returns null', async () => {
    const key = `deadline-pending-${Date.now()}`;
    const { escalationId } = await startWait(key);

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toBeNull();
    expect(await statusOf(escalationId)).toBe('cancelled');
  });

  it('retries while Long Tail is unreachable and settles when it is back', async () => {
    const key = `deadline-outage-${Date.now()}`;
    const { escalationId } = await startWait(key);
    await commitUndelivered(escalationId, 'resolved', { approved: false, notes: 'during outage' });
    const reachable = getLongTailConnection();
    configureLongTail(unreachableConnection());

    await new Promise((r) => setTimeout(r, (DEADLINE_SECONDS + 3) * 1000));
    configureLongTail(reachable);

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toEqual({ approved: false, notes: 'during outage' });
    expect(await statusOf(escalationId)).toBe('resolved');
  });
});
