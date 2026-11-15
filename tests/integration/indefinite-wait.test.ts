import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';

// One park lasts seconds here, so a wait passes several inside a test.
const PARK_SECONDS = vi.hoisted(() => 2);
vi.mock('../../src/constants', async (original) => {
  const actual = await original<typeof import('../../src/constants')>();
  return { ...actual, WAIT_DEFAULTS: { ...actual.WAIT_DEFAULTS, MAX_WAIT_SECONDS: PARK_SECONDS } };
});

import { conditional } from '../../src';
import { STEP } from '../../src/constants';
import { api, eventually, launchDbos, LT_DB, recreateDatabases, startLongTail, type Harness } from './harness';

async function openEndedWaitFn(key: string) {
  return conditional(key, { role: 'reviewer', type: 'open-ended', metadata: { orderId: key } });
}
const openEndedWait = DBOS.registerWorkflow(openEndedWaitFn, { name: 'openEndedWait' });

describe('a wait with no deadline', () => {
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

  async function startWait(key: string): Promise<{ escalationId: string }> {
    await DBOS.startWorkflow(openEndedWait, { workflowID: key })(key);
    return eventually(async () => {
      const { rows } = await db.query(`SELECT escalation_id AS "escalationId" FROM lt_durable_waits WHERE workflow_id = $1`, [key]);
      return rows[0];
    }, `wait for ${key}`);
  }

  const statusOf = async (escalationId: string) =>
    (await db.query('SELECT status FROM public.hmsh_escalations WHERE id = $1', [escalationId])).rows[0].status;
  const stepNames = async (workflowId: string) => ((await DBOS.listWorkflowSteps(workflowId)) ?? []).map((s) => s.name);
  const parks = async (workflowId: string) => (await stepNames(workflowId)).filter((name) => name === STEP.READ).length;

  it('stays pending across parks and completes when it is resolved', async () => {
    const key = `open-ended-${Date.now()}`;
    const { escalationId } = await startWait(key);

    await eventually(async () => (await parks(key)) >= 2, `two parks of ${key}`, PARK_SECONDS * 10_000);
    expect(await statusOf(escalationId)).toBe('pending');
    expect((await DBOS.getWorkflowStatus(key))?.status).toBe('PENDING');
    expect(await stepNames(key)).not.toContain(STEP.CLOSE);

    await api('POST', `/api/escalations/${escalationId}/resolve`, lt.adminToken, { resolverPayload: { approved: true } });
    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toEqual({ approved: true });
    expect(await statusOf(escalationId)).toBe('resolved');
  });

  it('returns an outcome Long Tail committed that reached no recv', async () => {
    const key = `open-ended-undelivered-${Date.now()}`;
    const { escalationId } = await startWait(key);
    await db.query('UPDATE lt_durable_waits SET delivered_at = NOW(), delivery = $2 WHERE escalation_id = $1', [escalationId, 'held-by-test']);
    await db.query(
      `UPDATE public.hmsh_escalations SET status = 'resolved', resolver_payload = $2::jsonb, resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [escalationId, JSON.stringify({ approved: false })],
    );

    await expect(DBOS.retrieveWorkflow(key).getResult()).resolves.toEqual({ approved: false });
    expect(await stepNames(key)).toContain(STEP.READ);
  });
});
