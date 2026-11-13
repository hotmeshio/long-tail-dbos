import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { configureLongTail, resetLongTailConnection } from '../../src/config';
import { LongTailRequestError, getEscalation, postCancel, postOpenWait } from '../../src/lt-client';

const BODY = { workflowId: 'wf-1', runScope: '', waitKey: 'review', role: 'reviewer', type: 'order-review' };

function respond(status: number, body: unknown, contentType = 'application/json') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

describe('Long Tail client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    configureLongTail({ url: 'https://lt.example.com', apiKey: 'lt_bot_key', requestTimeoutMs: 50 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLongTailConnection();
  });

  it('posts the wait with the bearer key and parses the JSON reply', async () => {
    fetchMock.mockResolvedValue(respond(201, { escalationId: 'e-1', status: 'pending', created: true }));
    const result = await postOpenWait(BODY);
    expect(result).toEqual({ escalationId: 'e-1', status: 'pending', created: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://lt.example.com/api/escalations/waits');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer lt_bot_key');
    expect(JSON.parse(init.body)).toEqual(BODY);
  });

  it('throws a typed error carrying status, body and request context on non-2xx', async () => {
    fetchMock.mockResolvedValue(respond(403, { error: 'no write access' }));
    const err = await postOpenWait(BODY).catch((e) => e);
    expect(err).toBeInstanceOf(LongTailRequestError);
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'no write access' });
    expect(err.context).toEqual({ method: 'POST', url: 'https://lt.example.com/api/escalations/waits' });
    expect(err.message).toMatch(/403: no write access/);
  });

  it('returns a non-JSON body as text', async () => {
    fetchMock.mockResolvedValue(respond(500, 'upstream down', 'text/plain'));
    const err = await postOpenWait(BODY).catch((e) => e);
    expect(err.body).toBe('upstream down');
  });

  it('times out with an abort and keeps the cause', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const err = await postOpenWait(BODY).catch((e) => e);
    expect(err).toBeInstanceOf(LongTailRequestError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/timed out/);
    expect(err.cause).toBeDefined();
  });

  it('wraps a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await postOpenWait(BODY).catch((e) => e);
    expect(err.message).toMatch(/failed/);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('cancels by id and treats an already-closed row as done', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { cancelled: true }));
    await postCancel('e-1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://lt.example.com/api/escalations/e-1/cancel');
    fetchMock.mockResolvedValueOnce(respond(409, { error: 'already resolved' }));
    await expect(postCancel('e-1')).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(respond(404, { error: 'not found' }));
    await expect(postCancel('e-1')).rejects.toBeInstanceOf(LongTailRequestError);
  });

  it('reads an escalation by id with a GET and no body', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'resolved', resolver_payload: '{"ok":true}' }));
    await expect(getEscalation('e-1')).resolves.toMatchObject({ status: 'resolved' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://lt.example.com/api/escalations/e-1');
    expect(init).toMatchObject({ method: 'GET' });
    expect(init.body).toBeUndefined();
    fetchMock.mockResolvedValueOnce(respond(404, { error: 'not found' }));
    await expect(getEscalation('e-1')).rejects.toBeInstanceOf(LongTailRequestError);
  });
});

