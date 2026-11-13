import { createServer } from 'http';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { configureLongTail } from '../src';
import { bootstrapApiKey } from './bootstrap';
import { LINE_QUEUE } from './machine-line';
import { ORDERS_QUEUE, reviewOrder } from './review-order/workflow';

// The example DBOS app process: the review-order and machine-line workflows.
// POST /orders/:id starts a review; the wait shows up in Long Tail. ?sla=30m sets the deadline (default 48h).
// Long Tail starts the invocable workflows on the orders and line queues (examples/long-tail.json).
// DBOS__VMID and DBOS__APPVERSION are fixed per replica so a restart recovers its parked waits.
async function main(): Promise<void> {
  const url = process.env.LT_URL ?? 'http://localhost:3400';
  configureLongTail({ url, apiKey: process.env.LT_API_KEY || (await bootstrapApiKey(url)) });
  DBOS.setConfig({ name: 'review-order', systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL });
  await DBOS.launch();
  await DBOS.registerQueue(ORDERS_QUEUE);
  await DBOS.registerQueue(LINE_QUEUE);

  const port = Number(process.env.PORT ?? 4000);
  createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/orders\/([\w-]+)$/.exec(pathname);
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    const orderId = match[1];
    const workflowId = `review-${orderId}`;
    const sla = searchParams.get('sla') ?? undefined;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: workflowId })(orderId, sla);
    void handle.getResult().then(
      (result) => console.log(`[review-order] ${workflowId}`, JSON.stringify(result)),
      (err: Error) => console.log(`[review-order] ${workflowId} ended: ${err.message}`),
    );
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ workflowId }));
  }).listen(port, () => console.log(`[examples] executor ${DBOS.executorID}, version ${DBOS.applicationVersion}, listening on ${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
