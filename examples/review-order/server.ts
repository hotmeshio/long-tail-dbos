import { createServer } from 'http';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { configureLongTail } from '../../src';
import { bootstrapApiKey } from './bootstrap';
import { reviewOrder } from './workflow';

// A DBOS app process. POST /orders/:id starts a review; the wait shows up in Long Tail.
// DBOS__VMID and DBOS__APPVERSION are fixed per replica so a restart recovers its parked waits.
async function main(): Promise<void> {
  const url = process.env.LT_URL ?? 'http://localhost:3000';
  configureLongTail({ url, apiKey: process.env.LT_API_KEY || (await bootstrapApiKey(url)) });
  DBOS.setConfig({ name: 'review-order', systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL });
  await DBOS.launch();

  const port = Number(process.env.PORT ?? 4000);
  createServer(async (req, res) => {
    const match = /^\/orders\/([\w-]+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    const orderId = match[1];
    const workflowId = `review-${orderId}`;
    const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: workflowId })(orderId);
    void handle.getResult().then((result) => console.log(`[review-order] ${workflowId}`, JSON.stringify(result)));
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ workflowId }));
  }).listen(port, () => console.log(`[review-order] executor ${DBOS.executorID}, version ${DBOS.applicationVersion}, listening on ${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
