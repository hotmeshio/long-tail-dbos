import { io, type Socket } from 'socket.io-client';

// The running docker compose stack: Long Tail on LT_URL, the review-order DBOS app on APP_URL.
export const LT_URL = process.env.LT_URL ?? 'http://localhost:3400';
export const APP_URL = process.env.APP_URL ?? 'http://localhost:4000';
export const ADMIN = { username: process.env.LT_ADMIN_USER ?? 'superadmin', password: process.env.LT_ADMIN_PASSWORD ?? 'l0ngt@1l' };
export const ROLE = 'reviewer';

export interface Escalation {
  id: string;
  status: string;
  role: string;
  type: string;
  workflow_id: string;
  workflow_type: string;
  assigned_to: string | null;
  metadata: Record<string, unknown>;
  escalation_payload: string | Record<string, unknown> | null;
}

export interface Reply<T> { status: number; data: T }

export class StackError extends Error {
  constructor(readonly method: string, readonly path: string, readonly status: number, readonly body: string) {
    super(`${method} ${path} ${status}: ${body}`);
  }
}

/** Long Tail's HTTP API as one caller: a person's token or a bot key. */
export class LongTail {
  constructor(readonly token: string) {}

  static async login(username = ADMIN.username, password = ADMIN.password): Promise<LongTail> {
    const { token } = await new LongTail('').request<{ token: string }>('POST', '/api/auth/login', { username, password });
    return new LongTail(token);
  }

  async send<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const res = await fetch(`${LT_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const reply = await this.send<T>(method, path, body);
    if (reply.status < 200 || reply.status >= 300) throw new StackError(method, path, reply.status, JSON.stringify(reply.data));
    return reply.data;
  }

  async escalationsFor(workflowId: string): Promise<Escalation[]> {
    const data = await this.request<{ escalations: Escalation[] }>('GET', `/api/escalations/by-workflow/${workflowId}`);
    return data.escalations;
  }

  pendingEscalation(workflowId: string): Promise<Escalation> {
    return eventually(async () => (await this.escalationsFor(workflowId)).find((r) => r.status === 'pending'), `pending escalation for ${workflowId}`);
  }

  claim(id: string): Promise<unknown> {
    return this.request('POST', `/api/escalations/${id}/claim`, {});
  }

  resolve(id: string, resolverPayload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/api/escalations/${id}/resolve`, { resolverPayload });
  }

  /** The workflow's result once the engine reports it closed. */
  async closedExecution(workflowId: string, timeoutMs?: number): Promise<{ status: string; provider_status: string; result: any; events: any[] }> {
    return eventually(async () => {
      const execution = await this.request<{ status: string; provider_status: string; result: any; events: any[] }>('GET', `/api/workflow-states/${workflowId}/execution`);
      return execution.status === 'running' ? undefined : execution;
    }, `${workflowId} to close`, timeoutMs);
  }
}

/** A unique id fragment per run, so repeated runs against one stack never collide. */
export function runId(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Start a review in the DBOS app. Returns the workflow id. */
export async function startReview(orderId: string, sla?: string): Promise<string> {
  const query = sla ? `?sla=${encodeURIComponent(sla)}` : '';
  const res = await fetch(`${APP_URL}/orders/${orderId}${query}`, { method: 'POST' });
  if (res.status !== 202) throw new StackError('POST', `/orders/${orderId}`, res.status, await res.text());
  return ((await res.json()) as { workflowId: string }).workflowId;
}

/** Poll until `read` returns a value. Test-only; the product is event driven. */
export async function eventually<T>(read: () => Promise<T | undefined | null>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface PushEvent { type: string; workflowId?: string; source?: string; at: number }

/** Records the dashboard's push events (Socket.IO) as a signed-in user sees them. */
export class PushListener {
  readonly events: PushEvent[] = [];
  private constructor(private readonly socket: Socket) {}

  static async connect(token: string, patterns: string[]): Promise<PushListener> {
    const socket = io(LT_URL, { path: '/socket.io', transports: ['websocket'], auth: { token } });
    const listener = new PushListener(socket);
    socket.onAny((_name: string, payload: unknown) => {
      const event = (typeof payload === 'string' ? JSON.parse(payload) : payload) as Omit<PushEvent, 'at'>;
      listener.events.push({ type: event.type, workflowId: event.workflowId, source: event.source, at: Date.now() });
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    for (const pattern of patterns) socket.emit('lt.subscribe', pattern);
    return listener;
  }

  waitFor(match: (event: PushEvent) => boolean, label: string, timeoutMs?: number): Promise<PushEvent> {
    return eventually(async () => this.events.find(match), label, timeoutMs);
  }

  close(): void {
    this.socket.close();
  }
}
