import { DBOS } from '@dbos-inc/dbos-sdk';
import { api, createClient, start } from '@hotmeshio/long-tail';

import { configureLongTail } from '../src';
import { dbosProvider } from '../src/provider';
import registered from './long-tail.json';
import { LINE_ROLES } from './machine-line/line';

// The workflows open waits on every role the examples park rows on, so the bot holds each as admin.
const ROLES = ['reviewer', ...LINE_ROLES];
const BOT = { name: 'dbos-workflows', roles: ROLES.map((role) => ({ role, type: 'admin' as const })) };

interface Bot { id: string; external_id: string }

/** Starts Long Tail in this process and points conditional() at it, acting as the workflow bot. */
export async function connectLongTail(env: NodeJS.ProcessEnv = process.env): Promise<{ shutdown(): Promise<void> }> {
  // 1. DBOS provider
  const systemDatabaseUrl = env.DBOS_SYSTEM_DATABASE_URL || env.DATABASE_URL;
  if (!systemDatabaseUrl) throw new Error('DATABASE_URL is required');
  await DBOS.migrate(systemDatabaseUrl);
  const provider = await dbosProvider({ systemDatabaseUrl });

  // 2. Long Tail on its database, with no HTTP server: the dashboard runs in its own container
  const instance = await start({
    ...(registered as Record<string, unknown>),
    roles: ROLES.map((role) => ({ role })),
    database: { connectionString: env.DATABASE_URL },
    server: { enabled: false },
    ...(env.JWT_SECRET ? { auth: { secret: env.JWT_SECRET } } : {}),
    durable: { provider },
  });

  // 3. The bot the workflows act as
  const bot = await findOrCreateBot();
  configureLongTail({ client: createClient({ auth: { userId: bot.id } }) });

  return {
    async shutdown() {
      await instance.shutdown();
      await provider.close();
    },
  };
}

async function findOrCreateBot(): Promise<Bot> {
  const listed = unwrap<{ bots?: Bot[] } | Bot[]>('list bots', await api.botAccounts.listBots({ search: BOT.name, limit: 50 }));
  const existing = (Array.isArray(listed) ? listed : listed.bots ?? []).find((b) => b.external_id === BOT.name);
  if (!existing) return unwrap<Bot>('create bot', await api.botAccounts.createBot(BOT));
  for (const role of BOT.roles) unwrap('add bot role', await api.botAccounts.addBotRole({ id: existing.id, ...role }));
  return existing;
}

function unwrap<T>(what: string, result: { status: number; data?: unknown; error?: string }): T {
  if (result.status >= 400) throw new Error(`${what}: ${result.error ?? result.status}`);
  return result.data as T;
}
