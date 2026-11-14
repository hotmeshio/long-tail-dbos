import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { configureLongTail, resetLongTailConnection } from '../../src/config';
import { LongTailRequestError, requestCancel, requestEscalation, requestOpenWait, requestToolCall } from '../../src/lt-client';
import { fakeClient } from '../helpers/fake-client';

const BODY = { workflowId: 'wf-1', runScope: '', waitKey: 'review', role: 'reviewer', type: 'order-review' };

describe('Long Tail client, in process', () => {
  const fetchMock = vi.fn();
  let client: ReturnType<typeof fakeClient>;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    client = fakeClient();
    configureLongTail({ client });
  });
  afterEach(() => {
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    resetLongTailConnection();
  });

  it('opens the wait through the SDK and returns its data', async () => {
    client.escalations.openWait.mockResolvedValue({ status: 201, data: { escalationId: 'e-1', status: 'pending', created: true } });
    await expect(requestOpenWait(BODY)).resolves.toEqual({ escalationId: 'e-1', status: 'pending', created: true });
    expect(client.escalations.openWait).toHaveBeenCalledWith(BODY);
  });

  it('throws a typed error carrying status, error and the SDK operation on non-2xx', async () => {
    client.escalations.openWait.mockResolvedValue({ status: 403, error: 'no write access' });
    const err: any = await requestOpenWait(BODY).catch((e) => e);
    expect(err).toBeInstanceOf(LongTailRequestError);
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'no write access' });
    expect(err.context).toEqual({ method: 'SDK', url: 'escalations.openWait' });
    expect(err.message).toMatch(/403: no write access/);
  });

  it('wraps a thrown SDK call and keeps the cause', async () => {
    client.escalations.get.mockRejectedValue(new Error('pool ended'));
    const err: any = await requestEscalation('e-1').catch((e) => e);
    expect(err).toBeInstanceOf(LongTailRequestError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/escalations.get failed/);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('reads an escalation by id', async () => {
    client.escalations.get.mockResolvedValue({ status: 200, data: { status: 'resolved', resolver_payload: { ok: true } } });
    await expect(requestEscalation('e-1')).resolves.toMatchObject({ status: 'resolved' });
    expect(client.escalations.get).toHaveBeenCalledWith({ id: 'e-1' });
  });

  it('cancels, treating an already closed row as done', async () => {
    await requestCancel('e-1');
    expect(client.escalations.cancel).toHaveBeenCalledWith({ id: 'e-1' });
    client.escalations.cancel.mockResolvedValue({ status: 409, error: 'already terminal' });
    await expect(requestCancel('e-1')).resolves.toBeUndefined();
  });

  it('rethrows a refused cancel', async () => {
    client.escalations.cancel.mockResolvedValue({ status: 403, error: 'no write access' });
    await expect(requestCancel('e-1')).rejects.toMatchObject({ status: 403 });
  });

  it('calls a tool with execute_as and returns its result', async () => {
    client.mcp.callTool.mockResolvedValue({ status: 200, data: { result: { total: 1 } } });
    const result = await requestToolCall({ client }, 'long-tail-admin', 'find_escalations', { search: 'o-1' }, 'ana');
    expect(result).toEqual({ total: 1 });
    expect(client.mcp.callTool).toHaveBeenCalledWith({
      id: 'long-tail-admin', toolName: 'find_escalations', arguments: { search: 'o-1' }, execute_as: 'ana',
    });
  });
});
