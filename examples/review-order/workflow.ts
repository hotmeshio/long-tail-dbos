import { DBOS } from '@dbos-inc/dbos-sdk';

import { conditional } from '../../src';

export interface ReviewDecision {
  approved: boolean;
  notes?: string;
}

export interface ReviewResult {
  orderId: string;
  status: 'shipped' | 'rejected' | 'expired-or-cancelled';
  decision?: ReviewDecision;
}

async function scoreOrder(orderId: string): Promise<{ risk: number }> {
  return { risk: orderId.length % 10 / 10 };
}

async function reviewOrderFn(orderId: string, sla = '48h'): Promise<ReviewResult> {
  const { risk } = await DBOS.runStep(() => scoreOrder(orderId), { name: 'score' });

  const decision = await conditional<ReviewDecision>(`review-${orderId}`, {
    role: 'reviewer',
    type: 'order-review',
    description: `Review order ${orderId}`,
    metadata: { orderId },
    data: { risk },
    timeout: sla,
  });

  if (!decision) return { orderId, status: 'expired-or-cancelled' };
  if (decision.approved) await DBOS.runStep(async () => ({ shipped: orderId }), { name: 'ship' });
  return { orderId, status: decision.approved ? 'shipped' : 'rejected', decision };
}

export const reviewOrder = DBOS.registerWorkflow(reviewOrderFn, { name: 'reviewOrder' });
