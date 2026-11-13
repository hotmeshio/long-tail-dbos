import { DBOS } from '@dbos-inc/dbos-sdk';

import { getLongTailConnection, validConnection } from './config';
import { STEP } from './constants';
import { postToolCall } from './lt-client';
import type { LongTailConnection } from './types';

export interface LongTailToolsOptions {
  /** Long Tail base URL; the configured connection's when absent. */
  url?: string;
  /** Bot API key or JWT; the configured connection's when absent. */
  apiKey?: string;
  /** Per-request timeout. Default 15 s. */
  requestTimeoutMs?: number;
}

export interface LongTailToolCallOptions {
  /** Run the tool as this user (id or external id); the caller must outrank them. */
  executeAs?: string;
}

export interface LongTailTools {
  /**
   * Call a tool on a Long Tail MCP server, built in or connected, by the
   * server's id or name, and return its result. Runs as a DBOS step named
   * `lt.tool:<server>/<tool>`: a completed call is not repeated, and a failed
   * one is not retried, since a tool may act. Throws LongTailRequestError on
   * a non-2xx reply.
   */
  call<T = unknown>(server: string, tool: string, args?: Record<string, unknown>, options?: LongTailToolCallOptions): Promise<T>;
}

/** Long Tail's MCP tools from DBOS code, over the configured connection unless `options` override it. */
export function longTailTools(options: LongTailToolsOptions = {}): LongTailTools {
  return {
    async call<T = unknown>(server: string, tool: string, args: Record<string, unknown> = {}, callOptions: LongTailToolCallOptions = {}): Promise<T> {
      if (!server || !tool) throw new Error('longTailTools().call(server, tool): server and tool are required');
      const connection = connectionFor(options);
      return DBOS.runStep(
        () => postToolCall<T>(connection, server, tool, args, callOptions.executeAs),
        { name: `${STEP.TOOL}:${server}/${tool}` },
      );
    },
  };
}

function connectionFor(options: LongTailToolsOptions): LongTailConnection {
  const configured = options.url && options.apiKey ? undefined : getLongTailConnection();
  return validConnection({
    url: options.url ?? configured!.url,
    apiKey: options.apiKey ?? configured!.apiKey,
    requestTimeoutMs: options.requestTimeoutMs ?? configured?.requestTimeoutMs,
  }, 'longTailTools');
}
