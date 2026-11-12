import { DBOS } from '@dbos-inc/dbos-sdk';

import { conditional } from '../../src';

/** Which code the process runs; the on-prem test flips it to model a redeploy. */
export const deployed = { revision: 1 };

export const AUDIT_PATCH = 'audit-before-review';

async function auditedReviewFn(orderId: string): Promise<{ orderId: string; approved: boolean; audited: boolean }> {
  await DBOS.runStep(async () => ({ orderId }), { name: 'score' });
  // Revision 2 adds an audit step. Waits parked under revision 1 replay without it.
  let audited = false;
  if (deployed.revision >= 2 && (await DBOS.patch(AUDIT_PATCH))) {
    await DBOS.runStep(async () => ({ audited: orderId }), { name: 'audit' });
    audited = true;
  }
  const decision = await conditional<{ approved: boolean }>(`audit-${orderId}`, {
    role: 'reviewer',
    type: 'order-review',
    metadata: { orderId },
  });
  return { orderId, approved: Boolean(decision?.approved), audited };
}

export const auditedReview = DBOS.registerWorkflow(auditedReviewFn, { name: 'auditedReview' });
