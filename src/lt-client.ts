import { getLongTailConnection } from './config';
import { LT_PATHS, WAIT_DEFAULTS } from './constants';
import type { LTCollectionConfig, LTWaitFields, LongTailConnection } from './types';

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

/** POST /api/escalations/waits: idempotent on (workflowId, runScope, waitKey). */
export function postOpenWait(body: OpenWaitBody): Promise<OpenWaitResponse> {
  return request<OpenWaitResponse>('POST', LT_PATHS.OPEN_WAIT, body);
}

/** The fields of an escalation row that decide a wait's outcome. */
export interface EscalationState {
  status: string;
  resolver_payload?: Record<string, unknown> | string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  updated_at?: string | null;
}

/** GET /api/escalations/:id. */
export function getEscalation(escalationId: string): Promise<EscalationState> {
  return request<EscalationState>('GET', LT_PATHS.ESCALATION(escalationId), undefined);
}

/** POST /api/escalations/:id/cancel. A row that is already closed is not an error. */
export async function postCancel(escalationId: string): Promise<void> {
  try {
    await request('POST', LT_PATHS.CANCEL(escalationId), {});
  } catch (err) {
    if (err instanceof LongTailRequestError && err.status === 409) return;
    throw err;
  }
}

/** POST /api/mcp/servers/:server/tools/:tool/call. `server` is an MCP server's id or name. */
export async function postToolCall<T>(
  connection: LongTailConnection,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  executeAs?: string,
): Promise<T> {
  const body = { arguments: args, ...(executeAs ? { execute_as: executeAs } : {}) };
  const reply = await request<{ result: T }>('POST', LT_PATHS.TOOL_CALL(server, tool), body, connection);
  return reply.result;
}

async function request<T>(method: string, path: string, body: unknown, connection = getLongTailConnection()): Promise<T> {
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
