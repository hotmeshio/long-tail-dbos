import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { LongTail, eventually, runId } from './stack';

const WORKFLOW = 'reviewOrderRequest';
const EVERY_MINUTE = '* * * * *';
const EVERY_OTHER_MINUTE = '*/2 * * * *';
// A tick lands within a minute (two for every other minute), plus the time to start and park.
const ONE_TICK_MS = 80_000;
const TWO_MINUTE_TICK_MS = 140_000;
const TEST_MS = 240_000;

interface Job { workflow_id: string; created_at: string; status: string }

// Long Tail starts a registered DBOS workflow on its cron schedule. These run on
// a stack that already ran them: every arming is a new job, so they pass again.
describe('e2e: workflow schedules on DBOS', () => {
  let admin: LongTail;
  let config: Record<string, unknown>;
  const started = Date.now();

  /** Save the config with a schedule and the orderId each run parks its review under. */
  async function schedule(cron: string | null, orderId: string, extra: Record<string, unknown> = {}): Promise<number> {
    const at = Date.now();
    await admin.request('PUT', `/api/workflows/${WORKFLOW}/config`, {
      ...config, ...extra, cron_schedule: cron, envelope_schema: { data: { orderId }, metadata: {} },
    });
    return at;
  }

  async function runsSince(since: number): Promise<Job[]> {
    const { jobs } = await admin.request<{ jobs: Job[] }>('GET', `/api/workflow-states/jobs?search=${WORKFLOW}-cron-&limit=50`);
    return (jobs ?? []).filter((job) => Date.parse(job.created_at) >= since);
  }

  /** The first scheduled run since `since` whose review carries `orderId`, the envelope the schedule saved. */
  async function runAfter(since: number, orderId: string, timeoutMs = ONE_TICK_MS): Promise<Job> {
    return eventually(async () => {
      for (const run of (await runsSince(since)).reverse()) {
        const rows = await admin.escalationsFor(run.workflow_id);
        if (rows.some((row) => row.metadata?.orderId === orderId)) return run;
      }
      return undefined;
    }, `a scheduled run for ${orderId} after ${new Date(since).toISOString()}`, timeoutMs);
  }

  async function stopRuns(): Promise<void> {
    for (const run of await runsSince(started)) {
      if (run.status === 'running') await admin.send('POST', `/api/workflows/${run.workflow_id}/terminate`, { reason: 'e2e cleanup' });
    }
  }

  beforeAll(async () => {
    admin = await LongTail.login();
    config = await admin.request('GET', `/api/workflows/${WORKFLOW}/config`);
  });

  afterEach(async () => {
    await admin.request('PUT', `/api/workflows/${WORKFLOW}/config`, { ...config, cron_schedule: null });
    await stopRuns();
  });

  afterAll(async () => {
    await admin?.request('PUT', `/api/workflows/${WORKFLOW}/config`, config);
    if (admin) await stopRuns();
  });

  it('starts the workflow on its schedule', async () => {
    const orderId = runId('cron');
    const since = await schedule(EVERY_MINUTE, orderId);
    await runAfter(since, orderId);

    const { schedules } = await admin.request<{ schedules: Array<{ workflow_type: string; active: boolean }> }>('GET', '/api/workflows/cron/status');
    expect(schedules).toContainEqual(expect.objectContaining({ workflow_type: WORKFLOW, active: true }));
  }, TEST_MS);

  it('keeps running after a save that leaves the schedule as it was', async () => {
    const orderId = runId('cron-keep');
    await runAfter(await schedule(EVERY_MINUTE, orderId), orderId);

    const saved = await schedule(EVERY_MINUTE, orderId, { description: `Saved at ${new Date().toISOString()}` });
    await runAfter(saved, orderId);
  }, TEST_MS);

  it('runs again after the schedule is turned off and on', async () => {
    const orderId = runId('cron-toggle');
    await schedule(EVERY_MINUTE, orderId);
    await schedule(null, orderId);

    const on = await schedule(EVERY_MINUTE, orderId);
    await runAfter(on, orderId);
  }, TEST_MS);

  it('runs on a changed schedule, and only on it', async () => {
    const orderId = runId('cron-change');
    await schedule(EVERY_MINUTE, orderId);

    const changed = await schedule(EVERY_OTHER_MINUTE, orderId);
    const run = await runAfter(changed, orderId, TWO_MINUTE_TICK_MS);
    // The replaced job's ticks start nothing: every run since the change starts on an even minute.
    const minutes = (await runsSince(changed + 5_000)).map((job) => new Date(job.created_at).getUTCMinutes());
    expect(new Date(run.created_at).getUTCMinutes() % 2).toBe(0);
    expect(minutes.every((m) => m % 2 === 0)).toBe(true);
  }, TEST_MS);
});
