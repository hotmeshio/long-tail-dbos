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

  it.each([
    ['PENDING', false],
    ['ENQUEUED', false],
    ['DELAYED', false],
    ['SUSPENDED', false],
    ['CANCELLED', false],
    ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', false],
    ['SUCCESS', true],
    ['ERROR', true],
    ['SOMETHING_NEW', true],
  ])('%s terminal is %s', (status, terminal) => {
    expect(isTerminal(status)).toBe(terminal);
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
