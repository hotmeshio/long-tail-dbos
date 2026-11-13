import type { LongTailConnection } from './types';

let connection: LongTailConnection | null = null;

/** Point the shim at Long Tail. Call once at startup, before DBOS.launch(). */
export function configureLongTail(config: LongTailConnection): void {
  connection = validConnection(config, 'configureLongTail');
}

export function getLongTailConnection(): LongTailConnection {
  if (!connection) throw new Error('Long Tail is not configured: call configureLongTail({ url, apiKey }) before conditional()');
  return connection;
}

/** The connection with a valid url and key, its url without a trailing slash. Throws naming `caller`. */
export function validConnection(config: LongTailConnection, caller: string): LongTailConnection {
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
