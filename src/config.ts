import type { LongTailClient, LongTailConnection, LongTailHttpConnection, LongTailInProcessConnection } from './types';

let connection: LongTailConnection | null = null;

/**
 * Point the shim at Long Tail. Call once at startup, before DBOS.launch():
 * `{ client }` when Long Tail runs in this process, `{ url, apiKey }` when it
 * is a separate service.
 */
export function configureLongTail(config: LongTailConnection): void {
  connection = validConnection(config, 'configureLongTail');
}

export function getLongTailConnection(): LongTailConnection {
  if (!connection) throw new Error('Long Tail is not configured: call configureLongTail({ client }) or configureLongTail({ url, apiKey }) before conditional()');
  return connection;
}

export function isInProcess(config: LongTailConnection): config is LongTailInProcessConnection {
  return 'client' in config && config.client !== undefined;
}

/** The connection validated for its kind; an HTTP url without a trailing slash. Throws naming `caller`. */
export function validConnection(config: LongTailConnection, caller: string): LongTailConnection {
  if (config && isInProcess(config)) return validInProcess(config, caller);
  return validHttp(config as LongTailHttpConnection, caller);
}

function validInProcess(config: LongTailInProcessConnection, caller: string): LongTailInProcessConnection {
  const missing = missingClientMethods(config.client);
  if (missing.length) {
    throw new Error(`${caller}: client lacks ${missing.join(', ')}; pass createClient() from @hotmeshio/long-tail 0.37.0 or later`);
  }
  return { client: config.client };
}

function missingClientMethods(client: LongTailClient): string[] {
  const methods: Array<[string, unknown]> = [
    ['escalations.openWait', client?.escalations?.openWait],
    ['escalations.get', client?.escalations?.get],
    ['escalations.cancel', client?.escalations?.cancel],
    ['mcp.callTool', client?.mcp?.callTool],
  ];
  return methods.filter(([, fn]) => typeof fn !== 'function').map(([name]) => name);
}

function validHttp(config: LongTailHttpConnection, caller: string): LongTailHttpConnection {
  if (!config?.url || typeof config.url !== 'string') throw new Error(`${caller}: url is required`);
  if (!config.apiKey || typeof config.apiKey !== 'string') throw new Error(`${caller}: apiKey is required`);
  try {
    new URL(config.url);
  } catch {
    throw new Error(`${caller}: url "${config.url}" is not a valid URL`);
  }
  return { ...config, url: config.url.replace(/\/+$/, '') };
}

/** For tests. */
export function resetLongTailConnection(): void {
  connection = null;
}
