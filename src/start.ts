import { readFileSync } from 'fs';
import { start } from '@hotmeshio/long-tail';

import { dbosProvider } from './provider';

/** Image entry: Long Tail with the DBOS provider, configured by environment. */
async function main(): Promise<void> {
  const provider = await dbosProvider({
    systemDatabaseUrl: required('DBOS_SYSTEM_DATABASE_URL'),
    systemDatabaseSchemaName: process.env.DBOS_SYSTEM_DATABASE_SCHEMA || undefined,
  });
  const instance = await start({
    ...extraConfig(),
    database: { connectionString: required('DATABASE_URL') },
    server: { port: Number(process.env.PORT || 3000) },
    durable: { provider, consoleUrl: process.env.DBOS_CONSOLE_URL || undefined },
  });
  const stop = async () => {
    await instance.shutdown();
    await provider.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Optional start() config from a JSON file (roles, seed, auth): LT_START_CONFIG=/config/longtail.json */
function extraConfig(): Record<string, unknown> {
  const path = process.env.LT_START_CONFIG;
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  for (const key of ['database', 'server', 'durable', 'workers', 'examples']) {
    if (key in parsed) throw new Error(`LT_START_CONFIG may not set "${key}"; it is set by environment or not allowed with DBOS`);
  }
  return parsed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
