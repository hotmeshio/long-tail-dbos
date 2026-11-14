/** Step names the shim registers; they appear in the DBOS step list. */
export const STEP = {
  OPEN: 'lt.open',
  CLOSE: 'lt.close',
  /** Prefix of a tool call's step name: `lt.tool:<server>/<tool>`. */
  TOOL: 'lt.tool',
} as const;

/** Reserved DBOS operation names (they appear in listWorkflowSteps). */
export const DBOS_OP = {
  RECV: 'DBOS.recv',
  SLEEP: 'DBOS.sleep',
  SEND: 'DBOS.send',
  GET_RESULT: 'DBOS.getResult',
  GET_STATUS: 'getStatus',
} as const;

/** DBOS operations that are bookkeeping, not work. */
export const DBOS_SYSTEM_STEPS: readonly string[] = [
  'DBOS.now',
  'DBOS.randomUUID',
  'DBOS.setEvent',
  'DBOS.getEvent',
  'DBOS.writeStream',
  'DBOS.closeStream',
  'DBOS.readStream',
  'DBOS.send',
  'getStatus',
];

export const PROVIDER_NAME = 'dbos';

export const WAIT_DEFAULTS = {
  /** Added to the SLA so Long Tail's expiry reaches the workflow before the recv deadline. */
  GRACE_SECONDS: 10 * 60,
  /** recv deadline when the wait has no SLA. */
  MAX_WAIT_SECONDS: 365 * 24 * 60 * 60,
  OPEN_ATTEMPTS: 10,
  REQUEST_TIMEOUT_MS: 15_000,
} as const;

export const LT_PATHS = {
  OPEN_WAIT: '/api/escalations/waits',
  CANCEL: (escalationId: string) => `/api/escalations/${encodeURIComponent(escalationId)}/cancel`,
  ESCALATION: (escalationId: string) => `/api/escalations/${encodeURIComponent(escalationId)}`,
  TOOL_CALL: (server: string, tool: string) => `/api/mcp/servers/${encodeURIComponent(server)}/tools/${encodeURIComponent(tool)}/call`,
} as const;

/** Long Tail SDK operations; an in-process call's LongTailRequestError names one as its context url. */
export const LT_OPERATIONS = {
  OPEN_WAIT: 'escalations.openWait',
  ESCALATION: 'escalations.get',
  CANCEL: 'escalations.cancel',
  TOOL_CALL: 'mcp.callTool',
} as const;

/** The context method of an in-process call's LongTailRequestError. */
export const IN_PROCESS_METHOD = 'SDK';

export const STEP_PAGE_SIZE = 500;

/** Connections the provider keeps for counting workflows in the executions list. */
export const COUNT_POOL_SIZE = 2;

/** Reason sent when the recv deadline passes before Long Tail delivered an outcome. */
export const CLOSE_REASON_DEADLINE = 'wait-deadline';

export const ESCALATION_STATUS = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;
