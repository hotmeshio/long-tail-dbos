import type { LongTailConnection } from './types';

let connection: LongTailConnection | null = null;

/** Point the shim at Long Tail. Call once at startup, before DBOS.launch(). */
export function configureLongTail(config: LongTailConnection): void {
  if (!config?.url || typeof config.url !== 'string') throw new Error('configureLongTail: url is required');
  if (!config.apiKey || typeof config.apiKey !== 'string') throw new Error('configureLongTail: apiKey is required');
  try {
    new URL(config.url);
  } catch {
    throw new Error(`configureLongTail: url "${config.url}" is not a valid URL`);
  }
  connection = { ...config, url: config.url.replace(/\/+$/, '') };
}

export function getLongTailConnection(): LongTailConnection {
  if (!connection) throw new Error('Long Tail is not configured: call configureLongTail({ url, apiKey }) before conditional()');
  return connection;
}

/** For tests. */
export function resetLongTailConnection(): void {
  connection = null;
}
