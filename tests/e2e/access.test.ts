import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { LongTail, ROLE, runId, startReview } from './stack';

const PASSWORD = 'e2e-pass-123';

// Role membership decides who works a DBOS wait, exactly as for a HotMesh one.
describe('e2e: who can work a DBOS wait', () => {
  let admin: LongTail;
  let reviewer: LongTail;
  let secondReviewer: LongTail;
  let outsider: LongTail;
  const userIds: string[] = [];

  const createUser = async (label: string, roles: Array<{ role: string; type: string }>): Promise<LongTail> => {
    const externalId = runId(label);
    const user = await admin.request<{ id: string }>('POST', '/api/users', { external_id: externalId, password: PASSWORD, roles });
    userIds.push(user.id);
    return LongTail.login(externalId, PASSWORD);
  };

  beforeAll(async () => {
    admin = await LongTail.login();
    reviewer = await createUser('reviewer', [{ role: ROLE, type: 'member' }]);
    secondReviewer = await createUser('reviewer2', [{ role: ROLE, type: 'member' }]);
    outsider = await createUser('outsider', []);
  });

  afterAll(async () => {
    for (const id of userIds) await admin?.send('DELETE', `/api/users/${id}`);
  });

  it('a member of the role claims and resolves, and the workflow completes', async () => {
    const workflowId = await startReview(runId('member'));
    const row = await reviewer.pendingEscalation(workflowId);

    await reviewer.claim(row.id);
    await reviewer.resolve(row.id, { approved: true, notes: 'member' });

    expect((await admin.closedExecution(workflowId)).result).toMatchObject({ status: 'shipped', decision: { notes: 'member' } });
  });

  it('a second member cannot take a claimed escalation', async () => {
    const workflowId = await startReview(runId('conflict'));
    const row = await reviewer.pendingEscalation(workflowId);
    await reviewer.claim(row.id);

    const taken = await secondReviewer.send('POST', `/api/escalations/${row.id}/claim`, {});
    expect(taken.status).toBe(409);

    await reviewer.resolve(row.id, { approved: true });
    await admin.closedExecution(workflowId);
  });

  it('someone outside the role can neither claim nor resolve', async () => {
    const workflowId = await startReview(runId('outsider'));
    const row = await admin.pendingEscalation(workflowId);

    expect((await outsider.send('POST', `/api/escalations/${row.id}/claim`, {})).status).toBe(403);
    // Resolve looks the row up through the caller's visibility, so a non-member gets 404.
    expect((await outsider.send('POST', `/api/escalations/${row.id}/resolve`, { resolverPayload: { approved: true } })).status).toBe(404);
    expect((await admin.escalationsFor(workflowId))[0].status).toBe('pending');

    await admin.resolve(row.id, { approved: false });
    await admin.closedExecution(workflowId);
  });

  it('a released claim lets another member take the work', async () => {
    const workflowId = await startReview(runId('release'));
    const row = await reviewer.pendingEscalation(workflowId);
    await reviewer.claim(row.id);
    await reviewer.request('POST', `/api/escalations/${row.id}/release`, {});

    await secondReviewer.claim(row.id);
    await secondReviewer.resolve(row.id, { approved: true, notes: 'second' });

    expect((await admin.closedExecution(workflowId)).result).toMatchObject({ decision: { notes: 'second' } });
  });
});
