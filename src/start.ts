import { readFileSync } from 'fs';
import { start } from '@hotmeshio/long-tail';

import { dbosProvider } from './provider';

const DEFAULT_ADMIN = 'superadmin';
const ENV_OWNED_KEYS = ['database', 'server', 'durable', 'workers', 'examples'];

/**
 * Long Tail with DBOS as the durable engine, configured from the environment:
 * DBOS_SYSTEM_DATABASE_URL (defaults to DATABASE_URL, one database), DBOS_SYSTEM_DATABASE_SCHEMA, DBOS_CONSOLE_URL,
 * DATABASE_URL or POSTGRES_*, PORT, JWT_SECRET, LT_ADMIN_USER / LT_ADMIN_PASSWORD / LT_ADMIN_EMAIL, LT_ROLES.
 * LT_START_CONFIG optionally names a JSON file with further start() settings.
 */
export async function startLongTailDbos(env: NodeJS.ProcessEnv = process.env) {
  // 1. DBOS provider
  const provider = await dbosProvider({
    systemDatabaseUrl: systemDatabaseUrl(env),
    systemDatabaseSchemaName: env.DBOS_SYSTEM_DATABASE_SCHEMA || undefined,
  });

  // 2. Long Tail
  const instance = await start({
    ...fileConfig(env.LT_START_CONFIG),
    database: env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
      host: env.POSTGRES_HOST, port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : undefined,
      user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: env.POSTGRES_DB,
    },
    server: { port: env.PORT ? Number(env.PORT) : undefined },
    ...(env.JWT_SECRET ? { auth: { secret: env.JWT_SECRET } } : {}),
    ...(env.LT_ADMIN_PASSWORD ? { seed: { admin: {
      externalId: env.LT_ADMIN_USER ?? DEFAULT_ADMIN, email: env.LT_ADMIN_EMAIL, password: env.LT_ADMIN_PASSWORD,
    } } } : {}),
    ...(env.LT_ROLES ? { roles: env.LT_ROLES.split(',').map((role) => ({ role: role.trim() })).filter((r) => r.role) } : {}),
    durable: { provider, consoleUrl: env.DBOS_CONSOLE_URL || undefined },
  });

  return {
    instance,
    async shutdown() {
      await instance.shutdown();
      await provider.close();
    },
  };
}

function systemDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DBOS_SYSTEM_DATABASE_URL || env.DATABASE_URL;
  if (!value) throw new Error('DBOS_SYSTEM_DATABASE_URL or DATABASE_URL is required');
  return value;
}

function fileConfig(path: string | undefined): Record<string, unknown> {
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  for (const key of ENV_OWNED_KEYS) {
    if (key in parsed) throw new Error(`LT_START_CONFIG may not set "${key}"; it is set by environment or not allowed with DBOS`);
  }
  return parsed;
}

if (require.main === module) {
  startLongTailDbos().then((running) => {
    const stop = async () => {
      await running.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
