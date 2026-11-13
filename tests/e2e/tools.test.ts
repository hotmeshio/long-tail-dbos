import { describe, it, expect, beforeAll } from 'vitest';

import { LongTail, runId, startReview } from './stack';

// longTailTools() from a DBOS step: the invoked workflow lists an order's
// escalations with Long Tail's built-in find_escalations tool, as its bot.
describe('e2e: Long Tail MCP tools from a DBOS step', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  it('calls a built-in tool and returns its result to the workflow', async () => {
    const orderId = runId('tools');
    const reviewId = await startReview(orderId);
    const review = await admin.pendingEscalation(reviewId);

    const workflowId = `${orderId}-lookup`;
    await admin.request('POST', '/api/workflows/orderEscalationsRequest/invoke', { data: { orderId }, workflowId });
    const execution = await admin.closedExecution(workflowId);

    expect(execution.status).toBe('completed');
    expect(execution.result).toEqual({
      data: { orderId, escalations: [{ id: review.id, status: 'pending', type: 'order-review', workflowId: reviewId }] },
    });
    const step = execution.events.find((e: any) => e.attributes?.activity_type === 'lt.tool:long-tail-admin/find_escalations');
    expect(step).toBeDefined();

    await admin.resolve(review.id, { approved: true });
    await admin.closedExecution(reviewId);
  });
});
