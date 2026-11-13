import { describe, it, expect, beforeAll } from 'vitest';
import { signalKeys } from '@hotmeshio/long-tail/machines/contracts';

import { EXAMPLE_LINE, EXAMPLE_STEPS } from '../../examples/machine-line/line';
import { LongTail, eventually, runId, type Escalation } from './stack';

// The machine-line workflows on DBOS, invoked from Long Tail. The test plays the
// machine gateway over HTTP: it resolves command rows with a machine's reply and
// adds each unit's release and arrival to a handoff row before resolving it.
describe('e2e: machine line on DBOS', () => {
  let admin: LongTail;

  beforeAll(async () => {
    admin = await LongTail.login();
  });

  async function invoke(workflow: string, workflowId: string, data: Record<string, unknown>): Promise<void> {
    await admin.request('POST', `/api/workflows/${workflow}/invoke`, { data, workflowId });
  }

  /** The workflow's open row, once the one before it has closed. */
  const openRow = (workflowId: string, type: string) =>
    eventually(async () => (await admin.escalationsFor(workflowId)).find((r) => r.status === 'pending' && r.type === type), `${type} row for ${workflowId}`);

  /** What the gateway does for a machine: record the sender's release and the receiver's arrival, then the receipt. */
  async function receiveAtMachine(row: Escalation, units: string[]): Promise<void> {
    for (const unitId of units) {
      if (row.metadata.fromMachine) await admin.request('POST', `/api/escalations/${row.id}/accumulate`, { itemKey: `released:${unitId}`, payload: { machineId: row.metadata.fromMachine } });
      await admin.request('POST', `/api/escalations/${row.id}/accumulate`, { itemKey: `arrived:${unitId}`, payload: { machineId: row.metadata.toMachine } });
    }
    await admin.resolve(row.id, { received: true, receiver: String(row.metadata.toMachine), units });
  }

  it('changes a machine over: the command row resolves with the machine\'s reply', async () => {
    const requestKey = runId('changeover');
    const recipe = { id: 'RCP-BOND-B', version: '1' };
    await invoke('machineCommand', requestKey, { ...EXAMPLE_LINE, machineId: 'press-01', role: 'line-bond', requestKey, op: 'changeover', args: { recipe } });

    const row = await openRow(requestKey, 'machine-command');
    expect(row).toMatchObject({ role: 'line-bond', workflow_type: 'machineCommand' });
    expect(row.metadata).toMatchObject({ machineId: 'press-01', op: 'changeover', args: { recipe } });

    const reply = { accepted: true, machineId: 'press-01', op: 'changeover', status: 'accepted', reason: 'changing over to RCP-BOND-B v1' };
    await admin.request('POST', '/api/escalations/resolve-by-signal-key', { signalKey: `machine-command-${requestKey}`, resolverPayload: reply });

    expect((await admin.closedExecution(requestKey)).result).toEqual({ data: reply });
  });

  it('routes units through both machines and the exit, retrying a refused dispatch', async () => {
    const routeKey = runId('route');
    const units = ['U1', 'U2'];
    await invoke('machineUnitRoute', routeKey, {
      ...EXAMPLE_LINE, routeKey, orderRef: `order-${routeKey}`, units: units.map((unitId) => ({ unitId, carrierId: null })), steps: EXAMPLE_STEPS,
    });

    // Line entry to the press: the press receives.
    const intoPress = await openRow(routeKey, 'handoff');
    expect(intoPress).toMatchObject({ role: 'line-bond' });
    expect(intoPress.metadata).toMatchObject({ jobId: `${routeKey}-press-01`, toMachine: 'press-01', recipeId: 'RCP-BOND-A' });
    await receiveAtMachine(intoPress, units);

    // The cutter refuses the first dispatch; the operator retries.
    const refused = await openRow(routeKey, 'handoff');
    expect(refused).toMatchObject({ role: 'line-finish' });
    await admin.resolve(refused.id, { received: false, errorCode: 'dispatch-refused', reason: 'door open' });
    const decision = await openRow(routeKey, 'handoff-error');
    expect(decision).toMatchObject({ role: 'line-operator', subtype: 'dispatch-refused' });
    expect(decision.metadata).toMatchObject({ decisions: ['retry', 'manual', 'scrap'], round: 1 });
    await admin.request('POST', '/api/escalations/resolve-by-signal-key', {
      signalKey: signalKeys.handoffError(routeKey, 1, 1), resolverPayload: { decision: 'retry', note: 'door closed' },
    });

    const intoCutter = await openRow(routeKey, 'handoff');
    expect(intoCutter.metadata).toMatchObject({ jobId: `${routeKey}-cut-01-a2`, senderJobId: `${routeKey}-press-01`, attempt: 2 });
    await receiveAtMachine(intoCutter, units);
    const items = await admin.request<{ items?: unknown[] }>('GET', `/api/escalations/items-by-signal-key?signalKey=${signalKeys.handoff(routeKey, 1, 2)}`);
    expect(JSON.stringify(items)).toContain('released:U2');

    // A person takes the units off the line.
    const exit = await openRow(routeKey, 'handoff');
    expect(exit).toMatchObject({ role: 'line-exit', subtype: 'exit' });
    await admin.resolve(exit.id, { received: true, receiver: 'packer', note: 'all good' });

    const { result } = await admin.closedExecution(routeKey);
    expect(result.data).toMatchObject({ status: 'complete', units });
    expect(result.data.history.map((h: { hop: number; attempt: number; received: boolean }) => [h.hop, h.attempt, h.received]))
      .toEqual([[0, 1, true], [1, 1, false], [1, 2, true], [2, 1, true]]);
  });

  it('ends a route as scrapped when the operator scraps a refused hop', async () => {
    const routeKey = runId('route-scrap');
    await invoke('machineUnitRoute', routeKey, {
      ...EXAMPLE_LINE, routeKey, orderRef: `order-${routeKey}`, units: [{ unitId: 'U9', carrierId: null }], steps: EXAMPLE_STEPS,
    });
    const intoPress = await openRow(routeKey, 'handoff');
    await admin.resolve(intoPress.id, { received: false, errorCode: 'no-reply' });
    const decision = await openRow(routeKey, 'handoff-error');
    await admin.resolve(decision.id, { decision: 'scrap', note: 'press offline' });

    expect((await admin.closedExecution(routeKey)).result.data).toMatchObject({ status: 'scrapped', at: 'entry', note: 'press offline' });
  });
});
