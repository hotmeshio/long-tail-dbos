/** Mirrors Long Tail's LTWaitOutcome; kept local so app processes need no Long Tail install. */
export interface LTWaitOutcome {
  waitKey: string;
  escalationId: string;
  status: 'resolved' | 'expired' | 'cancelled';
  data?: Record<string, unknown>;
  resolvedBy?: string;
  resolvedAt?: string;
}

/** Long Tail as a separate service, over HTTP. */
export interface LongTailHttpConnection {
  /** Long Tail base URL, e.g. https://longtail.example.com */
  url: string;
  /** Bot API key (lt_bot_...) or a JWT. */
  apiKey: string;
  /** Per-request timeout. Default 15 s. */
  requestTimeoutMs?: number;
}

/** Long Tail in this process: its SDK client, created with the workflow bot's identity. */
export interface LongTailInProcessConnection {
  /** `createClient({ auth: { userId } })` from @hotmeshio/long-tail 0.37.0 or later. */
  client: LongTailClient;
}

export type LongTailConnection = LongTailHttpConnection | LongTailInProcessConnection;

/** An SDK call's result, as Long Tail's api layer returns it. */
export interface LongTailClientResult<T = unknown> {
  status: number;
  data?: T;
  error?: string;
}

/** The part of Long Tail's SDK client the shim calls. */
export interface LongTailClient {
  escalations: {
    openWait(input: Record<string, unknown>): Promise<LongTailClientResult>;
    get(input: { id: string }): Promise<LongTailClientResult>;
    cancel(input: { id: string }): Promise<LongTailClientResult>;
  };
  mcp: {
    callTool(input: { id: string; toolName: string; arguments?: Record<string, unknown>; execute_as?: string }): Promise<LongTailClientResult>;
  };
}

export interface LTConditionalConfig extends LTCollectionConfig, LTWaitFields {
  role: string;
  type: string;
  subtype?: string;
  description?: string;
  /** 1 (most urgent) to 4. */
  priority?: number;
  metadata?: Record<string, unknown>;
  /** Shown to the resolver. */
  data?: Record<string, unknown>;
  /** Escalation SLA: '48h', '30m', '10s', '2d', or milliseconds. */
  timeout?: string | number;
  /** recv backstop when there is no SLA, in seconds. Default 365 days. */
  maxWaitSeconds?: number;
  /** `conditional()` only: add `$resolution` (who resolved it, and when) to a resolved payload. */
  withResolution?: boolean;
}

/** A knowledge entry the form reads. */
export interface LTLookupRef {
  domain: string;
  key: string;
  /** An edition number or label; the newest edition when absent. */
  version?: number | string;
  /** The name the form reads it under. */
  as?: string;
}

/** A stored file the form shows. */
export interface LTFileRef {
  /** The storage key. */
  path: string;
  /** The name the form reads it under. */
  as: string;
  name?: string;
  contentType?: string;
  /** Seconds the signed link lasts. */
  expiresIn?: number;
}

/** What the escalation carries beyond its queue and facets, as HotMesh's `conditional()` writes it. */
export interface LTWaitFields {
  /** Render-only data for the form: `formDefaults`, `confidence`, any `envelope.*` key. `batch_*` and `accumulate_*` keys are reserved. */
  envelope?: Record<string, unknown>;
  /** Stored as `envelope.lookups`. Pass it here or in `envelope`, not both. */
  lookups?: LTLookupRef[];
  /** Stored as `envelope.files`. Pass it here or in `envelope`, not both. */
  files?: LTFileRef[];
  /** The role form version the resolve UI renders, stored as `metadata.schema_version`. */
  schemaVersion?: number;
  /** Assigns the escalation when it is created; others can still claim it. */
  assignee?: string;
  /** With `assignee`: claims the escalation for this many minutes. */
  durationMinutes?: number;
  /** The first escalation of the chain or group this one belongs to. */
  originId?: string;
  /** The escalation this one follows from. */
  parentId?: string;
  /** Addresses the wait on the signal-key surfaces, such as resolve-by-signal-key. Unique across Long Tail. */
  signalKey?: string;
}

/** A wait's terminal outcome, as `conditionalOutcome()` returns it. */
export interface LTOutcome<T = Record<string, unknown>> {
  status: 'resolved' | 'expired' | 'cancelled';
  /** The resolver payload; on expiry, the collection an accumulator or `partialOnTimeout` batch kept; otherwise null. */
  data: T | null;
  escalationId: string;
  resolvedBy: string | null;
  /** ISO time the escalation closed. */
  resolvedAt: string | null;
}

/** Resolution provenance `conditional({ withResolution: true })` adds to a resolved payload. */
export interface LTResolution {
  escalationId: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/** A resolved payload with its resolution provenance. */
export type LTWithResolution<T> = T & { $resolution: LTResolution };

/** Output of the lt.open step; stored in the checkpoint. */
export interface OpenedWait {
  escalationId: string;
  waitKey: string;
  status: string;
  expiresAt: string | null;
  workflowType: string | null;
}

/**
 * The one argument Long Tail passes a workflow it invokes or schedules: the
 * form's `data`, the caller's `metadata`, and who started it in `lt`.
 */
export interface LTEnvelope<D = Record<string, unknown>> {
  data: D;
  metadata: Record<string, unknown>;
  lt: {
    userId?: string;
    principal?: { id: string; type?: string; displayName?: string; roles?: unknown[] };
    scopes?: string[];
    initiatedBy?: string;
  };
}

/** A batch item already satisfied when the wait opens. */
export interface LTFilledEntry {
  payload: Record<string, unknown>;
  /** ISO time the item was satisfied, from the source of record. */
  at: string;
  actor?: string;
}

/** Collect any item keys until `max`, the deadline or a resolve. */
export interface LTAccumulateConfig {
  /** Count that ends the wait. Absent: only the deadline or a resolve ends it. */
  max?: number;
  /** Default true. False makes `max` a cap: further adds answer `full`. */
  resolveAtMax?: boolean;
  /** Default true. False replaces a repeated item key in place. */
  unique?: boolean;
}

/** One escalation that collects many items, as HotMesh's `conditional()` declares it. */
export interface LTCollectionConfig {
  /** Item keys, filled once each. The last fill returns every item, keyed by item. */
  batch?: string[];
  /** Batch items already satisfied when the wait opens. */
  filled?: Record<string, LTFilledEntry>;
  /** A fill returns the items so far with `$filled` and `$trigger: 'fill'`: every key (`true`) or the listed keys. */
  wakeOnFill?: boolean | string[];
  /** A flagged item returns the items so far with `$flags` and `$trigger: 'flag'`. */
  wakeOnFlag?: boolean;
  /** On expiry, return the items filled so far with `$trigger: 'timeout'` instead of null. */
  partialOnTimeout?: boolean;
  /** Collect items into `$accumulated`. Exclusive with `batch`. */
  accumulate?: LTAccumulateConfig;
}

/** What ended a batch wait early; absent when every item was filled. */
export interface LTBatchMarkers {
  $trigger?: 'fill' | 'flag' | 'timeout';
  $filled?: string[];
  $filledAt?: Record<string, string>;
  $filledBy?: Record<string, string>;
  $flags?: Record<string, unknown>;
}

/** One accumulated item, in arrival order. */
export interface LTAccumulatedItem<P = Record<string, unknown>> {
  itemKey: string;
  payload?: P;
  at: string;
  actor?: string;
}

/** An accumulate wait's result: the items, what ended the wait, and a resolver's payload when a person resolved it. */
export type LTAccumulatorResult<P = Record<string, unknown>, R extends Record<string, unknown> = Record<string, unknown>> =
  Partial<R> & {
    $accumulated: LTAccumulatedItem<P>[];
    $trigger: 'count' | 'timeout' | 'resolve';
  };
