import { getLongTailConnection, isInProcess } from './config';
import { IN_PROCESS_METHOD, LT_OPERATIONS, LT_PATHS, WAIT_DEFAULTS } from './constants';
import type { LTCollectionConfig, LTWaitFields, LongTailClientResult, LongTailConnection, LongTailHttpConnection } from './types';

/** A non-2xx response or transport failure from Long Tail. */
export class LongTailRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: unknown,
    readonly context: { method: string; url: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LongTailRequestError';
  }
}

export interface OpenWaitBody extends LTCollectionConfig, LTWaitFields {
  workflowId: string;
  runScope: string;
  workflowType?: string;
  waitKey: string;
  role: string;
  type: string;
  subtype?: string;
  description?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
  expiresAt?: string;
}

export interface OpenWaitResponse {
  escalationId: string;
  status: string;
  created: boolean;
}

/** Open a wait: idempotent on (workflowId, runScope, waitKey). */
export function requestOpenWait(body: OpenWaitBody): Promise<OpenWaitResponse> {
  const connection = getLongTailConnection();
  if (isInProcess(connection)) {
    return inProcess<OpenWaitResponse>(LT_OPERATIONS.OPEN_WAIT, () => connection.client.escalations.openWait({ ...body }));
  }
  return request<OpenWaitResponse>('POST', LT_PATHS.OPEN_WAIT, body, connection);
}

/** The fields of an escalation row that decide a wait's outcome. */
export interface EscalationState {
  status: string;
  resolver_payload?: Record<string, unknown> | string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  updated_at?: string | null;
}

/** Read an escalation. */
export function requestEscalation(escalationId: string): Promise<EscalationState> {
  const connection = getLongTailConnection();
  if (isInProcess(connection)) {
    return inProcess<EscalationState>(LT_OPERATIONS.ESCALATION, () => connection.client.escalations.get({ id: escalationId }));
  }
  return request<EscalationState>('GET', LT_PATHS.ESCALATION(escalationId), undefined, connection);
}

/** Cancel an escalation. A row that is already closed is not an error. */
export async function requestCancel(escalationId: string): Promise<void> {
  const connection = getLongTailConnection();
  try {
    if (isInProcess(connection)) {
      await inProcess(LT_OPERATIONS.CANCEL, () => connection.client.escalations.cancel({ id: escalationId }));
    } else {
      await request('POST', LT_PATHS.CANCEL(escalationId), {}, connection);
    }
  } catch (err) {
    if (err instanceof LongTailRequestError && err.status === 409) return;
    throw err;
  }
}

/** Call a tool on an MCP server, by the server's id or name. */
export async function requestToolCall<T>(
  connection: LongTailConnection,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  executeAs?: string,
): Promise<T> {
  if (isInProcess(connection)) {
    const input = { id: server, toolName: tool, arguments: args, ...(executeAs ? { execute_as: executeAs } : {}) };
    const reply = await inProcess<{ result: T }>(LT_OPERATIONS.TOOL_CALL, () => connection.client.mcp.callTool(input));
    return reply.result;
  }
  const body = { arguments: args, ...(executeAs ? { execute_as: executeAs } : {}) };
  const reply = await request<{ result: T }>('POST', LT_PATHS.TOOL_CALL(server, tool), body, connection);
  return reply.result;
}

/** An SDK call; a non-2xx result throws as an HTTP reply would. */
async function inProcess<T>(operation: string, call: () => Promise<LongTailClientResult>): Promise<T> {
  const context = { method: IN_PROCESS_METHOD, url: operation };
  let result: LongTailClientResult;
  try {
    result = await call();
  } catch (err) {
    throw new LongTailRequestError(`Long Tail ${operation} failed`, undefined, undefined, context, { cause: err });
  }
  if (result.status < 200 || result.status >= 300) {
    const detail = result.error ? `: ${result.error}` : '';
    throw new LongTailRequestError(`Long Tail ${operation} returned ${result.status}${detail}`, result.status, { error: result.error }, context);
  }
  return result.data as T;
}

async function request<T>(method: string, path: string, body: unknown, connection: LongTailHttpConnection): Promise<T> {
  const { url, apiKey, requestTimeoutMs } = connection;
  const target = `${url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs ?? WAIT_DEFAULTS.REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted ? 'timed out' : 'failed';
    throw new LongTailRequestError(`Long Tail ${method} ${path} ${reason}`, undefined, undefined, { method, url: target }, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  const parsed = await parseBody(response);
  if (!response.ok) {
    const detail = typeof parsed === 'object' && parsed && 'error' in parsed ? `: ${(parsed as { error: unknown }).error}` : '';
    throw new LongTailRequestError(`Long Tail ${method} ${path} returned ${response.status}${detail}`, response.status, parsed, { method, url: target });
  }
  return parsed as T;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
