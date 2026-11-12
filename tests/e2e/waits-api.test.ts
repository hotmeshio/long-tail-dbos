import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { LongTail, ROLE, runId } from './stack';

interface Opened { escalationId: string; status: string; created: boolean }

// The endpoint conditional() calls from a DBOS step, with a bot key.
describe('e2e: opening waits with a bot key', () => {
  let admin: LongTail;
  let writer: LongTail;
  let stranger: LongTail;
  const botIds: string[] = [];
  const opened: string[] = [];

  const createBot = async (label: string, roles: Array<{ role: string; type: string }>): Promise<LongTail> => {
    const bot = await admin.request<{ id: string }>('POST', '/api/bot-accounts', { name: runId(label), roles });
    botIds.push(bot.id);
    const key = await admin.request<{ rawKey: string }>('POST', `/api/bot-accounts/${bot.id}/api-keys`, { name: 'e2e' });
    return new LongTail(key.rawKey);
  };

  const waitBody = (workflowId: string) => ({
    workflowId,
    workflowType: 'reviewOrder',
    waitKey: `review-${workflowId}`,
    role: ROLE,
    type: 'order-review',
    description: 'e2e wait',
    metadata: { orderId: workflowId },
    data: { risk: 0.1 },
  });

  beforeAll(async () => {
    admin = await LongTail.login();
    writer = await createBot('writer', [{ role: ROLE, type: 'member' }]);
    stranger = await createBot('stranger', []);
  });

  afterAll(async () => {
    for (const id of opened) await admin?.send('POST', `/api/escalations/${id}/cancel`, {});
    for (const id of botIds) await admin?.send('DELETE', `/api/bot-accounts/${id}`);
  });

  it('creates the escalation once and returns the same one when the wait is opened again', async () => {
    const workflowId = runId('waits-idem');
    const first = await writer.send<Opened>('POST', '/api/escalations/waits', waitBody(workflowId));
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ status: 'pending', created: true });
    opened.push(first.data.escalationId);

    const again = await writer.send<Opened>('POST', '/api/escalations/waits', waitBody(workflowId));
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ escalationId: first.data.escalationId, created: false });

    const rows = await admin.escalationsFor(workflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: ROLE, workflow_type: 'reviewOrder', metadata: { orderId: workflowId } });
  });

  it('refuses a bot without write access to the role', async () => {
    const reply = await stranger.send('POST', '/api/escalations/waits', waitBody(runId('waits-403')));
    expect(reply.status).toBe(403);
  });

  it('refuses a body without a workflow id or wait key', async () => {
    const { workflowId: _w, waitKey: _k, ...body } = waitBody(runId('waits-400'));
    expect((await writer.send('POST', '/api/escalations/waits', body)).status).toBe(400);
  });

  it('refuses a request without credentials', async () => {
    expect((await new LongTail('').send('POST', '/api/escalations/waits', waitBody(runId('waits-401')))).status).toBe(401);
  });
});
