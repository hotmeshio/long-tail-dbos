import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbos = vi.hoisted(() => ({ runStep: vi.fn((fn: () => Promise<unknown>) => fn()) }));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { runStep: dbos.runStep } }));

import { configureLongTail, resetLongTailConnection } from '../../src/config';
import { LongTailRequestError } from '../../src/lt-client';
import { longTailTools } from '../../src/tools';
import { fakeClient } from '../helpers/fake-client';

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('longTailTools', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    dbos.runStep.mockClear();
    configureLongTail({ url: 'https://lt.example.com', apiKey: 'lt_bot_key', requestTimeoutMs: 50 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLongTailConnection();
  });

  it('posts the arguments to the call route as a named step and returns the result', async () => {
    fetchMock.mockResolvedValue(respond(200, { result: { escalations: [{ id: 'e-1' }], total: 1 } }));
    const result = await longTailTools().call<{ total: number }>('long-tail-admin', 'find_escalations', { search: 'o-1' });

    expect(result).toEqual({ escalations: [{ id: 'e-1' }], total: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://lt.example.com/api/mcp/servers/long-tail-admin/tools/find_escalations/call');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer lt_bot_key');
    expect(JSON.parse(init.body)).toEqual({ arguments: { search: 'o-1' } });
    expect(dbos.runStep).toHaveBeenCalledWith(expect.any(Function), { name: 'lt.tool:long-tail-admin/find_escalations' });
  });

  it('sends execute_as and encodes a server name with spaces', async () => {
    fetchMock.mockResolvedValue(respond(200, { result: 'ok' }));
    await longTailTools().call('My Server', 'do/it', {}, { executeAs: 'ana' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://lt.example.com/api/mcp/servers/My%20Server/tools/do%2Fit/call');
    expect(JSON.parse(init.body)).toEqual({ arguments: {}, execute_as: 'ana' });
  });

  it('throws a typed error with status, body and request context on non-2xx', async () => {
    fetchMock.mockResolvedValue(respond(403, { error: 'Forbidden: find_escalations is not available to you' }));
    const err: any = await longTailTools().call('long-tail-admin', 'find_escalations').catch((e) => e);
    expect(err).toBeInstanceOf(LongTailRequestError);
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'Forbidden: find_escalations is not available to you' });
    expect(err.context).toEqual({ method: 'POST', url: 'https://lt.example.com/api/mcp/servers/long-tail-admin/tools/find_escalations/call' });
    expect(err.message).toMatch(/403: Forbidden/);
  });

  it('wraps a network failure and keeps the cause', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err: any = await longTailTools().call('long-tail-admin', 'find_escalations').catch((e) => e);
    expect(err).toBeInstanceOf(LongTailRequestError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/failed/);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('uses its own url and key when given, without a configured connection', async () => {
    resetLongTailConnection();
    fetchMock.mockResolvedValue(respond(200, { result: 1 }));
    await longTailTools({ url: 'https://other.example.com/', apiKey: 'other_key' }).call('s', 't');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://other.example.com/api/mcp/servers/s/tools/t/call');
    expect(init.headers.authorization).toBe('Bearer other_key');
  });

  it('overrides one field of the configured connection', async () => {
    fetchMock.mockResolvedValue(respond(200, { result: 1 }));
    await longTailTools({ apiKey: 'scoped_key' }).call('s', 't');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://lt.example.com/api/mcp/servers/s/tools/t/call');
    expect(init.headers.authorization).toBe('Bearer scoped_key');
  });

  it('fails loud without a server, tool or connection', async () => {
    await expect(longTailTools().call('', 't')).rejects.toThrow(/server and tool are required/);
    resetLongTailConnection();
    await expect(longTailTools().call('s', 't')).rejects.toThrow(/configureLongTail/);
    await expect(longTailTools({ url: 'not a url', apiKey: 'k' }).call('s', 't')).rejects.toThrow(/longTailTools: url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls through the SDK client when Long Tail runs in process', async () => {
    const client = fakeClient();
    client.mcp.callTool.mockResolvedValue({ status: 200, data: { result: 'ok' } });
    configureLongTail({ client });
    await expect(longTailTools().call('s', 't', { a: 1 })).resolves.toBe('ok');
    expect(client.mcp.callTool).toHaveBeenCalledWith({ id: 's', toolName: 't', arguments: { a: 1 } });
    expect(dbos.runStep).toHaveBeenCalledWith(expect.any(Function), { name: 'lt.tool:s/t' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses HTTP when given a url and key, even with Long Tail in process', async () => {
    const client = fakeClient();
    configureLongTail({ client });
    fetchMock.mockResolvedValue(respond(200, { result: 1 }));
    await longTailTools({ url: 'https://other.example.com', apiKey: 'other_key' }).call('s', 't');
    expect(fetchMock.mock.calls[0][0]).toBe('https://other.example.com/api/mcp/servers/s/tools/t/call');
    expect(client.mcp.callTool).not.toHaveBeenCalled();
  });

  it('refuses half an HTTP override when Long Tail runs in process', async () => {
    configureLongTail({ client: fakeClient() });
    await expect(longTailTools({ apiKey: 'k' }).call('s', 't')).rejects.toThrow(/url and apiKey are both required/);
  });
});
