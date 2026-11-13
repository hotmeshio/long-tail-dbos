import { DBOS } from '@dbos-inc/dbos-sdk';

import { conditional, longTailTools, type LTAccumulatorResult, type LTBatchMarkers, type LTEnvelope } from '../../src';

export interface ReviewDecision {
  approved: boolean;
  notes?: string;
}

export interface ReviewResult {
  orderId: string;
  status: 'shipped' | 'rejected' | 'expired' | 'cancelled';
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

  if (decision === false) return { orderId, status: 'expired' };
  if (decision === null) return { orderId, status: 'cancelled' };
  if (decision.approved) await DBOS.runStep(async () => ({ shipped: orderId }), { name: 'ship' });
  return { orderId, status: decision.approved ? 'shipped' : 'rejected', decision };
}

export const reviewOrder = DBOS.registerWorkflow(reviewOrderFn, { name: 'reviewOrder' });

/** The queue Long Tail enqueues invoked workflows on; the registered config names it as `taskQueue`. */
export const ORDERS_QUEUE = 'orders';

/** Invoked from Long Tail: the envelope carries the order id from the invoke form. */
async function reviewOrderRequestFn(envelope: LTEnvelope<{ orderId: string }>): Promise<{ data: ReviewResult }> {
  return { data: await reviewOrderFn(envelope.data.orderId) };
}

export const reviewOrderRequest = DBOS.registerWorkflow(reviewOrderRequestFn, { name: 'reviewOrderRequest' });

export type InspectedSides = Partial<Record<'left' | 'right', { passed: boolean }>> & LTBatchMarkers;

/** Invoked from Long Tail: one escalation, one fill per side. On expiry it returns the sides inspected so far. */
async function inspectOrderRequestFn(envelope: LTEnvelope<{ orderId: string; timeout?: string }>) {
  const { orderId, timeout = '48h' } = envelope.data;
  const sides = await conditional<InspectedSides>(`inspect-${orderId}`, {
    role: 'reviewer',
    type: 'order-inspection',
    description: `Inspect both sides of order ${orderId}`,
    metadata: { orderId },
    batch: ['left', 'right'],
    partialOnTimeout: true,
    timeout,
  });
  return { data: { orderId, sides } };
}

export const inspectOrderRequest = DBOS.registerWorkflow(inspectOrderRequestFn, { name: 'inspectOrderRequest' });

/** Invoked from Long Tail: collects approvals until `approvals` arrive, the deadline passes, or a person closes it. */
async function collectApprovalsRequestFn(envelope: LTEnvelope<{ orderId: string; approvals?: number; timeout?: string }>) {
  const { orderId, approvals = 2, timeout = '48h' } = envelope.data;
  const collected = await conditional<LTAccumulatorResult<{ approver: string }>>(`approvals-${orderId}`, {
    role: 'reviewer',
    type: 'order-approvals',
    description: `Collect ${approvals} approvals for order ${orderId}`,
    metadata: { orderId },
    accumulate: { max: approvals },
    timeout,
  });
  if (!collected) return { data: { orderId, status: 'cancelled' } };
  return { data: { orderId, trigger: collected.$trigger, approvers: collected.$accumulated.map((item) => item.payload?.approver) } };
}

export const collectApprovalsRequest = DBOS.registerWorkflow(collectApprovalsRequestFn, { name: 'collectApprovalsRequest' });

interface FoundEscalations {
  escalations: Array<{ id: string; status: string; type: string; workflow_id: string }>;
}

/** Invoked from Long Tail: reads an order's escalations through Long Tail's MCP tools, from a DBOS step. */
async function orderEscalationsRequestFn(envelope: LTEnvelope<{ orderId: string }>) {
  const { orderId } = envelope.data;
  const found = await longTailTools().call<FoundEscalations>('long-tail-admin', 'find_escalations', { facets: { orderId } });
  const escalations = found.escalations.map(({ id, status, type, workflow_id }) => ({ id, status, type, workflowId: workflow_id }));
  return { data: { orderId, escalations } };
}

export const orderEscalationsRequest = DBOS.registerWorkflow(orderEscalationsRequestFn, { name: 'orderEscalationsRequest' });
