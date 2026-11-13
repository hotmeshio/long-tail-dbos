import { describe, it, expect, beforeAll } from 'vitest';

import { LongTail, ROLE, eventually, runId } from './stack';

const WORKFLOW = 'reviewOrderRequest';
const QUEUE = 'orders';

describe('e2e: registering and invoking DBOS workflows from Long Tail', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  it('reports that the engine starts workflows', async () => {
    const settings = await admin.request<any>('GET', '/api/settings');
    expect(settings.engine).toMatchObject({ provider: 'dbos', native: false, capabilities: { start: true } });
  });

  it('lists the workflow LT_START_CONFIG registered', async () => {
    const { workflows } = await admin.request<any>('GET', '/api/workflows/discovered');
    expect(workflows).toContainEqual(expect.objectContaining({ workflow_type: WORKFLOW, task_queue: QUEUE, registered: true, invocable: true }));
    const invocable = await admin.request<any>('GET', '/api/workflows/invocable');
    expect(invocable.workflows.map((w: any) => w.workflow_type)).toContain(WORKFLOW);
  });

  it('invokes the workflow with the envelope and returns its result', async () => {
    const orderId = runId('invoke');
    const started = await admin.request<any>('POST', `/api/workflows/${WORKFLOW}/invoke`, {
      data: { orderId }, metadata: { source: 'e2e' }, workflowId: orderId,
    });
    expect(started).toEqual({ workflowId: orderId, message: 'Workflow started' });

    const row = await admin.pendingEscalation(orderId);
    expect(row).toMatchObject({ role: ROLE, type: 'order-review', workflow_type: WORKFLOW, workflow_id: orderId });
    expect((await admin.send('GET', `/api/workflows/${orderId}/result`)).status).toBe(202);

    await admin.resolve(row.id, { approved: true, notes: 'invoked' });
    const execution = await admin.closedExecution(orderId);
    expect(execution.result).toMatchObject({ data: { orderId, status: 'shipped', decision: { approved: true, notes: 'invoked' } } });

    const result = await admin.request<any>('GET', `/api/workflows/${orderId}/result`);
    expect(result).toMatchObject({ state: 'completed', result: { data: { status: 'shipped' } } });
  });

  it('validates the input schema before starting anything', async () => {
    const reply = await admin.send<any>('POST', `/api/workflows/${WORKFLOW}/invoke`, { data: {} });
    expect(reply.status).toBe(422);
  });

  it('refuses a workflow with no registered config', async () => {
    const reply = await admin.send<any>('POST', '/api/workflows/reviewOrder/invoke', { data: { orderId: 'x' } });
    expect(reply.status).toBe(404);
    expect(reply.data.error).toMatch(/register a config/);
  });

  it('starts the workflow on its cron schedule', async () => {
    const config = await admin.request<any>('GET', `/api/workflows/${WORKFLOW}/config`);
    const orderId = runId('cron');
    const scheduled = { ...config, cron_schedule: '* * * * *', envelope_schema: { data: { orderId }, metadata: {} } };
    await admin.request('PUT', `/api/workflows/${WORKFLOW}/config`, scheduled);
    try {
      const run = await eventually(async () => {
        const { jobs } = await admin.request<any>('GET', `/api/workflow-states/jobs?search=${WORKFLOW}-cron-&limit=5`);
        return jobs?.[0];
      }, 'a scheduled run', 80_000);
      expect(run.workflow_id).toMatch(new RegExp(`^${WORKFLOW}-cron-`));
      const row = await admin.pendingEscalation(run.workflow_id);
      expect(row.metadata).toMatchObject({ orderId });
      await admin.request('POST', `/api/escalations/${row.id}/cancel`);
    } finally {
      await admin.request('PUT', `/api/workflows/${WORKFLOW}/config`, { ...config, cron_schedule: null });
    }
  });
});
