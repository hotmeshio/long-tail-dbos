/** Mirrors Long Tail's LTWaitOutcome; kept local so app processes need no Long Tail install. */
export interface LTWaitOutcome {
  waitKey: string;
  escalationId: string;
  status: 'resolved' | 'expired' | 'cancelled';
  data?: Record<string, unknown>;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface LongTailConnection {
  /** Long Tail base URL, e.g. https://longtail.example.com */
  url: string;
  /** Bot API key (lt_bot_...) or a JWT. */
  apiKey: string;
  /** Per-request timeout. Default 15 s. */
  requestTimeoutMs?: number;
}

export interface LTConditionalConfig {
  role: string;
  type: string;
  subtype?: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  metadata?: Record<string, unknown>;
  /** Shown to the resolver. */
  data?: Record<string, unknown>;
  /** Escalation SLA: '48h', '30m', '10s', '2d', or milliseconds. */
  timeout?: string | number;
  /** recv backstop when there is no SLA, in seconds. Default 365 days. */
  maxWaitSeconds?: number;
}

/** Output of the lt.open step; stored in the checkpoint. */
export interface OpenedWait {
  escalationId: string;
  waitKey: string;
  status: string;
  expiresAt: string | null;
  workflowType: string | null;
}
