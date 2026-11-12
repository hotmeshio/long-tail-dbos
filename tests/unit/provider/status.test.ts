import { describe, it, expect } from 'vitest';

import { isTerminal, toJobState, toJobStatus } from '../../../src/provider/status';

describe('DBOS status mapping', () => {
  it.each([
    ['PENDING', 'running'],
    ['ENQUEUED', 'running'],
    ['DELAYED', 'running'],
    ['SUSPENDED', 'running'],
    ['SUCCESS', 'completed'],
    ['ERROR', 'failed'],
    ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'failed'],
    ['CANCELLED', 'cancelled'],
    ['SOMETHING_NEW', 'unknown'],
    [undefined, 'unknown'],
  ])('%s is %s', (status, state) => {
    expect(toJobState(status)).toBe(state);
  });

  it('treats only waiting states as able to receive', () => {
    expect(isTerminal('PENDING')).toBe(false);
    expect(isTerminal('SUSPENDED')).toBe(false);
    expect(isTerminal('SUCCESS')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
  });

  it('describes a found workflow with times', () => {
    const status = toJobStatus('wf-1', { workflowID: 'wf-1', status: 'SUCCESS', workflowName: 'reviewOrder', createdAt: 0, completedAt: 1000 } as any);
    expect(status).toEqual({
      workflowId: 'wf-1', workflowType: 'reviewOrder', state: 'completed', providerState: 'SUCCESS',
      startedAt: '1970-01-01T00:00:00.000Z', closedAt: '1970-01-01T00:00:01.000Z',
    });
  });

  it('describes a missing workflow as unknown', () => {
    expect(toJobStatus('wf-x', undefined)).toEqual({ workflowId: 'wf-x', state: 'unknown', providerState: 'NOT_FOUND' });
  });
});
