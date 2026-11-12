// Records a real DBOS run (status + steps) for the steps-map fixture and checks
// two runtime behaviors: a workflow name accessor and a send to a finished workflow.
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { writeFileSync } from 'fs';

const SYS = `postgresql://postgres:password@localhost:${process.env.PG_PORT ?? 5425}/lt_dbos_probe_sys`;

async function childFn(x: number) { return x * 2; }
const child = DBOS.registerWorkflow(childFn, { name: 'probeChild' });

const ltOpen = DBOS.registerStep(async (key: string) => ({ escalationId: '11111111-1111-4111-8111-111111111111', waitKey: key, expiresAt: null }), { name: 'lt.open' });

async function reviewFn(orderId: string) {
  const status = await DBOS.getWorkflowStatus(DBOS.workflowID!);
  const score = await DBOS.runStep(async () => ({ orderId, risk: 0.2 }), { name: 'score' });
  await DBOS.sleep(50);
  const c = await DBOS.startWorkflow(child)(21);
  const childResult = await c.getResult();
  const failing = await DBOS.runStep(async () => { throw new Error('boom'); }, { name: 'flaky' }).catch((e: Error) => e.message);
  await ltOpen('review-1');
  const outcome = await DBOS.recv<Record<string, unknown>>('review-1', { timeoutSeconds: 30 });
  return { workflowName: status?.workflowName, score, childResult, failing, outcome };
}
const review = DBOS.registerWorkflow(reviewFn, { name: 'reviewOrder' });

async function main() {
  DBOS.setConfig({ name: 'lt-dbos-probe', systemDatabaseUrl: SYS });
  await DBOS.launch();
  const client = await DBOSClient.create({ systemDatabaseUrl: SYS });
  const id = `probe-${Date.now()}`;
  const handle = await DBOS.startWorkflow(review, { workflowID: id })('order-7');
  await new Promise((r) => setTimeout(r, 1500));
  const midStatus = await client.getWorkflow(id);
  const midSteps = await client.listWorkflowSteps(id);
  await client.send(id, { waitKey: 'review-1', escalationId: '11111111-1111-4111-8111-111111111111', status: 'resolved', data: { approved: true } }, 'review-1', '11111111-1111-4111-8111-111111111111');
  const result = await handle.getResult();
  const status = await client.getWorkflow(id);
  const steps = await client.listWorkflowSteps(id);
  let sendToFinished: string;
  try {
    await client.send(id, { late: true }, 'review-1', 'late-key');
    sendToFinished = 'stored-without-error';
  } catch (e: any) { sendToFinished = `threw ${e.constructor.name}: ${e.message}`; }
  let sendToMissing: string;
  try { await client.send('no-such-workflow', {}, 't', 'k'); sendToMissing = 'stored'; } catch (e: any) { sendToMissing = `threw ${e.constructor.name}`; }
  const errors = (_k: string, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v);
  writeFileSync('tests/fixtures/dbos-run.json', JSON.stringify({ midStatus, midSteps, status, steps }, errors, 2));
  console.log(JSON.stringify({ result, sendToFinished, sendToMissing, stepNames: steps?.map((s) => s.name) }, null, 2));
  await client.destroy();
  await DBOS.shutdown();
}
main().catch((e) => { console.error(e); process.exit(1); });
