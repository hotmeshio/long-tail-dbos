import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { start } from '@hotmeshio/long-tail';

import { configureLongTail } from '../../src';
import { dbosProvider, type DbosProvider } from '../../src/provider';

const PG = { host: 'localhost', port: 5415, user: 'postgres', password: 'password' };
export const LT_DB = 'lt_dbos_e2e';
export const SYS_DB = 'lt_dbos_e2e_sys';
const url = (db: string) => `postgresql://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;
export const SYS_URL = url(SYS_DB);
export const PORT = 3917;
export const BASE = `http://localhost:${PORT}`;
const ADMIN = { externalId: 'e2e-admin', password: 'e2e-pass-123' };

/** Drop and recreate this suite's own databases. Never touches longtail or longtail_test. */
export async function recreateDatabases(): Promise<void> {
  const admin = new Client({ ...PG, database: 'postgres' });
  await admin.connect();
  for (const db of [LT_DB, SYS_DB]) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [db]);
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
  }
  await admin.end();
}

/** A stable executor id per replica and a pinned version: a restart recovers its own parked waits. */
export const REPLICA = { executorID: 'replica-a', applicationVersion: 'review-order-1' };

export async function launchDbos(identity: { executorID: string; applicationVersion: string } = REPLICA): Promise<void> {
  DBOS.setConfig({ name: 'lt-dbos-e2e', systemDatabaseUrl: SYS_URL, ...identity });
  await DBOS.launch();
}

export interface Harness {
  provider: DbosProvider;
  adminToken: string;
  shutdown(): Promise<void>;
}

/** Long Tail in process with the DBOS provider, a reviewer role, and a bot key for the workflow side. */
export async function startLongTail(): Promise<Harness> {
  const provider = await dbosProvider({ systemDatabaseUrl: SYS_URL });
  const lt = await start({
    database: { connectionString: url(LT_DB) },
    server: { port: PORT },
    auth: { secret: 'e2e-jwt-secret' },
    seed: { admin: ADMIN },
    roles: [{ role: 'reviewer', title: 'Reviewer' }],
    durable: { provider, relay: { sweepMs: 300, reconcileMs: 0 } },
  } as any);

  const login = await api<{ token: string }>('POST', '/api/auth/login', '', { username: ADMIN.externalId, password: ADMIN.password });
  const bot = await api<{ id: string }>('POST', '/api/bot-accounts', login.token, { name: 'dbos-workflows', roles: [{ role: 'reviewer', type: 'admin' }] });
  const key = await api<Record<string, string>>('POST', `/api/bot-accounts/${bot.id}/api-keys`, login.token, { name: 'e2e' });
  const apiKey = key.rawKey ?? key.key ?? key.api_key;
  if (!apiKey) throw new Error(`no api key in ${JSON.stringify(key)}`);
  configureLongTail({ url: BASE, apiKey });

  return {
    provider,
    adminToken: login.token,
    async shutdown() {
      await lt.shutdown();
      await provider.close();
    },
  };
}

export async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
  return data as T;
}

/** Poll until `read` returns a value. Test-only; production code is event driven. */
export async function eventually<T>(read: () => Promise<T | undefined | null>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The relay's recorded delivery for a wait, once it has one. */
export async function deliveryOf(escalationId: string): Promise<string> {
  const db = new Client({ ...PG, database: LT_DB });
  await db.connect();
  try {
    return await eventually(async () => {
      const { rows } = await db.query('SELECT delivery FROM lt_durable_waits WHERE escalation_id = $1', [escalationId]);
      return rows[0]?.delivery as string | undefined;
    }, `delivery of ${escalationId}`);
  } finally {
    await db.end();
  }
}
