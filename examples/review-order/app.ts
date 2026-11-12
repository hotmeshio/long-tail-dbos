import { DBOS } from '@dbos-inc/dbos-sdk';

import { configureLongTail } from '../../src';
import { reviewOrder } from './workflow';

// Run: LT_URL=http://localhost:3000 LT_API_KEY=lt_bot_... DBOS_SYSTEM_DATABASE_URL=postgresql://... npx tsx examples/review-order/app.ts order-42
async function main(): Promise<void> {
  configureLongTail({ url: process.env.LT_URL!, apiKey: process.env.LT_API_KEY! });
  DBOS.setConfig({ name: 'review-order', systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL });
  await DBOS.launch();
  const orderId = process.argv[2] ?? `order-${Date.now()}`;
  const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: `review-${orderId}` })(orderId);
  console.log(`waiting on Long Tail for ${orderId}; resolve it in the dashboard`);
  console.log(await handle.getResult());
  await DBOS.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
