import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { reviewOrder } from '../../examples/review-order/workflow';
import { api, DEPLOYMENT, launchDbos, LT_DB, pendingRow, recreateDatabases, startLongTail, SYS_URL, type Harness } from './harness';

const PG = { host: 'localhost', port: Number(process.env.PG_PORT ?? 5425), user: 'postgres', password: 'password' };

async function scalar<T>(connection: { connectionString: string } | { database: string }, sql: string, params: unknown[] = []): Promise<T> {
  const db = new Client({ ...PG, ...connection });
  await db.connect();
  try {
    return Object.values((await db.query(sql, params)).rows[0])[0] as T;
  } finally {
    await db.end();
  }
}

describe(`deployment: ${DEPLOYMENT.connection} connection, ${DEPLOYMENT.databases} databases`, () => {
  let lt: Harness;
  const id = `deployment-${Date.now()}`;

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: id })('order-deploy');
    const row = await pendingRow(id, lt.adminToken);
    await api('POST', `/api/escalations/${row.id}/resolve`, lt.adminToken, { resolverPayload: { approved: true } });
    await handle.getResult();
  });

  afterAll(async () => {
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  it('keeps the workflow in the DBOS system database the deployment names', async () => {
    const status = await scalar<string>({ connectionString: SYS_URL }, 'SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1', [id]);
    expect(status).toBe('SUCCESS');
    const dbosInLongTail = await scalar<boolean>({ database: LT_DB }, `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dbos')`);
    expect(dbosInLongTail).toBe(DEPLOYMENT.databases === 'shared');
  });

  it('reaches Long Tail as the bot, by SDK in process or by key over HTTP', async () => {
    const keysUsed = await scalar<number>({ database: LT_DB }, 'SELECT count(*)::int FROM lt_bot_api_keys WHERE last_used_at IS NOT NULL');
    if (DEPLOYMENT.connection === 'in-process') expect(keysUsed).toBe(0);
    else expect(keysUsed).toBeGreaterThan(0);
  });
});
