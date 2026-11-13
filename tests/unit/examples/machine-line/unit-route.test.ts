import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dbos-inc/dbos-sdk', async () => (await import('../../../helpers/scripted-waits')).dbosStub);
vi.mock('../../../../src', async () => ({ conditional: (await import('../../../helpers/scripted-waits')).conditional }));

import { waits } from '../../../helpers/scripted-waits';
import { machineUnitRoute } from '../../../../examples/machine-line/unit-route';
import { EXAMPLE_LINE, EXAMPLE_STEPS } from '../../../../examples/machine-line/line';
import type { UnitRouteInput } from '../../../../examples/machine-line/route';

const INPUT: UnitRouteInput = { ...EXAMPLE_LINE, routeKey: 'R1', orderRef: 'order-1', units: [{ unitId: 'U1', carrierId: null }], steps: EXAMPLE_STEPS };
const run = (input: Partial<UnitRouteInput> = {}) => machineUnitRoute({ data: { ...INPUT, ...input }, metadata: {}, lt: {} }) as Promise<{ data: any }>;
const RECEIVED = { received: true, $accumulated: [], $trigger: 'resolve' };
const refused = { received: false, errorCode: 'dispatch-refused', reason: 'door open', $accumulated: [], $trigger: 'resolve' };

describe('machineUnitRoute on DBOS', () => {
  beforeEach(() => waits.reset());

  it('walks every hop to the exit and completes', async () => {
    waits.on(/^handoff-R1-/, RECEIVED);
    const { data } = await run();

    expect(data).toMatchObject({ status: 'complete', units: ['U1'] });
    expect(waits.keys()).toEqual(['handoff-R1-s0-a1', 'handoff-R1-s1-a1', 'handoff-R1-s2-a1']);
    expect(waits.calls.map((c) => c.config.role)).toEqual(['line-bond', 'line-finish', 'line-exit']);
  });

  it('opens each handoff as an accumulator addressed by its key, with the SLA', async () => {
    waits.on(/^handoff-R1-/, RECEIVED);
    await run({ handoffTimeout: '5m' });

    const first = waits.byKey('handoff-R1-s0-a1').config;
    expect(first).toMatchObject({ type: 'handoff', subtype: 'bond', priority: 2, accumulate: {}, timeout: '5m', signalKey: 'handoff-R1-s0-a1' });
    expect(first.metadata).toMatchObject({ jobId: 'R1-press-01', toMachine: 'press-01', units: INPUT.units });
  });

  it('asks the operator after a refusal, and a retry runs the hop again as a new attempt', async () => {
    waits.once('handoff-R1-s0-a1', refused);
    waits.on(/^handoff-error-/, { decision: 'retry' });
    waits.on(/^handoff-R1-/, RECEIVED);
    const { data } = await run();

    expect(data.status).toBe('complete');
    expect(waits.keys().slice(0, 3)).toEqual(['handoff-R1-s0-a1', 'handoff-error-R1-s0-a1', 'handoff-R1-s0-a2']);
    const ask = waits.byKey('handoff-error-R1-s0-a1').config;
    expect(ask).toMatchObject({ role: 'line-operator', type: 'handoff-error', subtype: 'dispatch-refused', priority: 1, signalKey: 'handoff-error-R1-s0-a1' });
    expect(ask.metadata).toMatchObject({ decisions: ['retry', 'manual', 'scrap'], round: 1, errorCode: 'dispatch-refused', detail: 'door open' });
    expect(waits.byKey('handoff-R1-s0-a2').config.metadata).toMatchObject({ jobId: 'R1-press-01-a2', attempt: 2 });
    expect(waits.byKey('handoff-R1-s1-a1').config.metadata).toMatchObject({ senderJobId: 'R1-press-01-a2' });
  });

  it('asks again when the operator picks a decision this failure does not allow', async () => {
    waits.once('handoff-R1-s1-a1', { received: false, errorCode: 'sender-rejected', result: 'reject', $accumulated: [], $trigger: 'resolve' });
    waits.once(/^handoff-error-/, { decision: 'retry' });
    waits.once(/^handoff-error-/, { decision: 'scrap', note: 'cracked' });
    waits.on(/^handoff-R1-/, RECEIVED);
    const { data } = await run();

    expect(data).toMatchObject({ status: 'scrapped', at: 'press-01', note: 'cracked' });
    expect(waits.byKey('handoff-error-R1-s1-a1').config.metadata.decisions).toEqual(['manual', 'scrap']);
    expect(waits.byKey('handoff-error-R1-s1-a1-r2').config.description).toMatch(/^retry is not available here\./);
  });

  it('hands the units to a person from where they stopped on manual', async () => {
    waits.once('handoff-R1-s1-a1', refused);
    waits.on(/^handoff-error-/, { decision: 'manual' });
    waits.on(/^handoff-R1-/, RECEIVED);
    const { data } = await run();

    expect(data).toMatchObject({ status: 'manual', at: 'press-01', received: true });
    const exit = waits.byKey('handoff-R1-s3-a1').config;
    expect(exit).toMatchObject({ role: 'line-exit', subtype: 'exit' });
    expect(exit.metadata).toMatchObject({ fromMachine: 'press-01', senderJobId: 'R1-press-01' });
  });

  it('stops the sender\'s job before asking, when a handoff is cancelled', async () => {
    waits.once('handoff-R1-s1-a1', null);
    waits.on(/^job-stop-/, { accepted: true, op: 'stop' });
    waits.on(/^handoff-error-/, { decision: 'scrap' });
    waits.on(/^handoff-R1-/, RECEIVED);
    const { data } = await run();

    expect(data.status).toBe('scrapped');
    expect(waits.keys()).toEqual(['handoff-R1-s0-a1', 'handoff-R1-s1-a1', 'job-stop-R1-s1-a1', 'handoff-error-R1-s1-a1']);
    const stop = waits.byKey('job-stop-R1-s1-a1').config;
    expect(stop).toMatchObject({ role: 'line-bond', type: 'machine-command', subtype: 'stop', signalKey: 'job-stop-R1-s1-a1' });
    expect(stop.metadata).toMatchObject({ machineId: 'press-01', op: 'stop', args: { jobId: 'R1-press-01' } });
  });

  it('scraps the units when the operator does not answer in time', async () => {
    waits.once('handoff-R1-s0-a1', refused);
    waits.on(/^handoff-error-/, null);
    const { data } = await run({ operatorTimeout: '1h' });

    expect(data).toMatchObject({ status: 'scrapped', at: 'entry', note: 'no decision before the timeout' });
    expect(waits.byKey('handoff-error-R1-s0-a1').config.timeout).toBe('1h');
  });
});
