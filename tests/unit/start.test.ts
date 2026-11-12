import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const start = vi.fn().mockResolvedValue({ shutdown: vi.fn() });
vi.mock('@hotmeshio/long-tail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hotmeshio/long-tail')>()),
  start: (...args: unknown[]) => start(...args),
}));
const close = vi.fn();
const dbosProvider = vi.fn().mockResolvedValue({ name: 'dbos', close });
vi.mock('../../src/provider', () => ({ dbosProvider: (...args: unknown[]) => dbosProvider(...args) }));

import { startLongTailDbos } from '../../src/start';

const SYS = 'postgres://u:p@db/dbos_sys';

function writeConfig(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lt-dbos-')), 'longtail.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('startLongTailDbos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts Long Tail with the DBOS provider from the environment', async () => {
    await startLongTailDbos({
      DBOS_SYSTEM_DATABASE_URL: SYS, DBOS_CONSOLE_URL: 'http://c/{workflowId}',
      DATABASE_URL: 'postgres://u:p@db/lt', PORT: '3000', JWT_SECRET: 's',
    });
    expect(dbosProvider).toHaveBeenCalledWith({ systemDatabaseUrl: SYS, systemDatabaseSchemaName: undefined });
    const config = start.mock.calls[0][0];
    expect(config.durable).toEqual({ provider: expect.objectContaining({ name: 'dbos' }), consoleUrl: 'http://c/{workflowId}' });
    expect(config.database).toEqual({ connectionString: 'postgres://u:p@db/lt' });
    expect(config.server).toEqual({ port: 3000 });
    expect(config.auth).toEqual({ secret: 's' });
    expect(config.workers).toBeUndefined();
  });

  it('builds the database from POSTGRES_*', async () => {
    await startLongTailDbos({ DBOS_SYSTEM_DATABASE_URL: SYS, POSTGRES_HOST: 'db', POSTGRES_PORT: '5432', POSTGRES_DB: 'lt' });
    expect(start.mock.calls[0][0].database).toMatchObject({ host: 'db', port: 5432, database: 'lt' });
  });

  it('seeds the admin and declares roles from the environment', async () => {
    await startLongTailDbos({ DBOS_SYSTEM_DATABASE_URL: SYS, LT_ADMIN_PASSWORD: 'pw', LT_ROLES: 'reviewer, approver' });
    const config = start.mock.calls[0][0];
    expect(config.seed).toEqual({ admin: { externalId: 'superadmin', email: undefined, password: 'pw' } });
    expect(config.roles).toEqual([{ role: 'reviewer' }, { role: 'approver' }]);
  });

  it('merges LT_START_CONFIG and lets the environment win', async () => {
    const path = writeConfig({ roles: [{ role: 'reviewer', title: 'Reviewer' }], seed: { admin: { externalId: 'ops', password: 'pw' } } });
    await startLongTailDbos({ DBOS_SYSTEM_DATABASE_URL: SYS, LT_START_CONFIG: path, LT_ROLES: 'approver' });
    const config = start.mock.calls[0][0];
    expect(config.seed).toEqual({ admin: { externalId: 'ops', password: 'pw' } });
    expect(config.roles).toEqual([{ role: 'approver' }]);
  });

  it('rejects LT_START_CONFIG keys the environment owns', async () => {
    const path = writeConfig({ durable: {} });
    await expect(startLongTailDbos({ DBOS_SYSTEM_DATABASE_URL: SYS, LT_START_CONFIG: path })).rejects.toThrow(/durable/);
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps DBOS in the Long Tail database when no system database url is set', async () => {
    await startLongTailDbos({ DATABASE_URL: 'postgres://u:p@db/lt' });
    expect(dbosProvider).toHaveBeenCalledWith({ systemDatabaseUrl: 'postgres://u:p@db/lt', systemDatabaseSchemaName: undefined });
    expect(start.mock.calls[0][0].database).toEqual({ connectionString: 'postgres://u:p@db/lt' });
  });

  it('fails loud without DBOS_SYSTEM_DATABASE_URL or DATABASE_URL', async () => {
    await expect(startLongTailDbos({})).rejects.toThrow(/DBOS_SYSTEM_DATABASE_URL/);
    expect(start).not.toHaveBeenCalled();
  });

  it('closes the provider on shutdown', async () => {
    const running = await startLongTailDbos({ DBOS_SYSTEM_DATABASE_URL: SYS });
    await running.shutdown();
    expect(close).toHaveBeenCalled();
  });
});
