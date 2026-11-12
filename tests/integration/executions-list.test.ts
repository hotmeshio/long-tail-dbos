import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { reviewOrder } from '../../examples/review-order/workflow';
import { api, eventually, launchDbos, recreateDatabases, startLongTail, type Harness } from './harness';

interface Page { jobs: Array<{ workflow_id: string; entity: string; status: string; provider_status: string; created_at: string }>; total: number }

describe('Long Tail on DBOS: executions list', () => {
  let lt: Harness;
  const prefix = `list-${Date.now()}`;
  const list = (query: string) => api<Page>('GET', `/api/workflow-states/jobs?${query}`, lt.adminToken);

  beforeAll(async () => {
    await recreateDatabases();
    await launchDbos();
    lt = await startLongTail();

    // Three reviews: one resolved, two still waiting.
    const handles = await Promise.all(['a', 'b', 'c'].map((s) => DBOS.startWorkflow(reviewOrder, { workflowID: `${prefix}-${s}` })(`${prefix}-${s}`)));
    const rows = await eventually(async () => {
      const data = await api<any>('GET', `/api/escalations/by-workflow/${prefix}-a`, lt.adminToken);
      return (Array.isArray(data) ? data : data.escalations).find((r: any) => r.status === 'pending');
    }, 'escalation for a');
    await api('POST', `/api/escalations/${rows.id}/resolve`, lt.adminToken, { resolverPayload: { approved: true } });
    await handles[0].getResult();
    await eventually(async () => (await DBOS.listWorkflows({ workflow_id_prefix: prefix, status: 'PENDING' })).length === 2 || undefined, 'two pending');
  });

  afterAll(async () => {
    await lt?.shutdown();
    await DBOS.shutdown();
  });

  it('lists by id prefix, newest first, with a total that matches DBOS', async () => {
    const page = await list(`search=${prefix}`);
    const fromDbos = await DBOS.listWorkflows({ workflow_id_prefix: prefix });
    expect(page.total).toBe(fromDbos.length);
    expect(page.total).toBe(3);
    const started = page.jobs.map((j) => Date.parse(j.created_at));
    expect(started).toEqual([...started].sort((x, y) => y - x));
    expect(page.jobs.every((j) => j.entity === 'reviewOrder')).toBe(true);
  });

  it('filters by state, and the count follows the filter', async () => {
    const running = await list(`search=${prefix}&status=running`);
    const completed = await list(`search=${prefix}&status=completed`);
    expect(running.total).toBe(2);
    expect(running.jobs.every((j) => j.status === 'running' && j.provider_status === 'PENDING')).toBe(true);
    expect(completed).toMatchObject({ total: 1, jobs: [{ workflow_id: `${prefix}-a`, status: 'completed', provider_status: 'SUCCESS' }] });
  });

  it('filters by type and pages', async () => {
    const first = await list(`search=${prefix}&entity=reviewOrder&limit=2`);
    const second = await list(`search=${prefix}&entity=reviewOrder&limit=2&offset=2`);
    expect([first.total, second.total]).toEqual([3, 3]);
    expect([...first.jobs, ...second.jobs].map((j) => j.workflow_id).sort()).toEqual([`${prefix}-a`, `${prefix}-b`, `${prefix}-c`]);
    expect((await list(`search=${prefix}&entity=otherWorkflow`)).total).toBe(0);
  });
});
