import { describe, it, expect, beforeAll } from 'vitest';

import { LongTail, eventually, runId, startReview } from './stack';

interface Page { jobs: Array<{ workflow_id: string; entity: string; status: string; provider_status: string }>; total: number }

// What the dashboard reads about the engine on a DBOS deployment.
describe('e2e: the engine surfaces on DBOS', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  it('settings report DBOS with execution, terminate and list', async () => {
    const settings = await admin.request<{ engine: Record<string, unknown> }>('GET', '/api/settings');
    expect(settings.engine).toMatchObject({ provider: 'dbos', native: false, capabilities: { execution: true, terminate: true, list: true } });
  });

  it('the executions list pages DBOS workflows by id prefix and state', async () => {
    const prefix = runId('list');
    const [doneId, waitingId] = await Promise.all([startReview(`${prefix}-a`), startReview(`${prefix}-b`)]);
    const done = await admin.pendingEscalation(doneId);
    await admin.pendingEscalation(waitingId);
    await admin.resolve(done.id, { approved: true });
    await admin.closedExecution(doneId);

    const search = `review-${prefix}`;
    const all = await admin.request<Page>('GET', `/api/workflow-states/jobs?search=${search}`);
    expect(all.total).toBe(2);
    expect(all.jobs.map((j) => j.workflow_id).sort()).toEqual([doneId, waitingId].sort());

    const running = await admin.request<Page>('GET', `/api/workflow-states/jobs?search=${search}&status=running`);
    expect(running.jobs).toEqual([expect.objectContaining({ workflow_id: waitingId, entity: 'reviewOrder', status: 'running', provider_status: 'PENDING' })]);
    const completed = await admin.request<Page>('GET', `/api/workflow-states/jobs?search=${search}&status=completed&limit=1`);
    expect(completed).toMatchObject({ total: 1, jobs: [{ workflow_id: doneId, provider_status: 'SUCCESS' }] });

    await admin.request('POST', `/api/workflows/${waitingId}/terminate`, { reason: 'e2e cleanup' });
  });

  it('describe reports a waiting workflow as running', async () => {
    const workflowId = await startReview(runId('describe'));
    const row = await admin.pendingEscalation(workflowId);
    const status = await admin.request('GET', `/api/workflows/${workflowId}/describe`);
    expect(status).toMatchObject({ workflowId, workflowType: 'reviewOrder', state: 'running', providerState: 'PENDING' });

    await admin.resolve(row.id, { approved: true });
    await eventually(async () => (await admin.request<{ state: string }>('GET', `/api/workflows/${workflowId}/describe`)).state === 'completed' || undefined, 'completed');
  });

  it('rejects list filters with quotes or commas', async () => {
    expect((await admin.send('GET', `/api/workflow-states/jobs?search=${encodeURIComponent("x' OR 1")}`)).status).toBe(400);
    expect((await admin.send('GET', '/api/workflow-states/jobs?entity=a,b')).status).toBe(400);
  });

  it('routes that run HotMesh workflows answer 501 and name the engine', async () => {
    for (const path of ['/api/yaml-workflows', '/api/tasks', '/api/workflows/discovered']) {
      const reply = await admin.send<{ error: string }>('GET', path);
      expect(reply.status, path).toBe(501);
      expect(reply.data.error).toContain('dbos');
    }
  });

  it('the tool catalog lists only tools registered on this engine', async () => {
    const catalog = await admin.request<{ categories: Array<{ tools: Array<{ name: string }> }> }>('GET', '/api/capabilities');
    const names = catalog.categories.flatMap((c) => c.tools.map((t) => t.name));
    expect(names).toEqual(expect.arrayContaining(['find_escalations', 'claim_escalation', 'resolve_escalation']));
    expect(names).not.toContain('list_yaml_workflows');
    expect(names).not.toContain('invoke_workflow');
  });
});
