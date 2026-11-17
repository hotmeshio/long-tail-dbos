import { DBOS } from '@dbos-inc/dbos-sdk';

import { connectLongTail } from '../long-tail';
import { reviewOrder } from './workflow';

// Run: DATABASE_URL=postgresql://... npx tsx examples/review-order/app.ts order-42
async function main(): Promise<void> {
  const longTail = await connectLongTail();
  DBOS.setConfig({ name: 'review-order', systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL || process.env.DATABASE_URL });
  await DBOS.launch();
  const orderId = process.argv[2] ?? `order-${Date.now()}`;
  const handle = await DBOS.startWorkflow(reviewOrder, { workflowID: `review-${orderId}` })(orderId);
  console.log(`waiting on Long Tail for ${orderId}; resolve it in the dashboard`);
  console.log(await handle.getResult());
  await DBOS.shutdown();
  await longTail.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
