import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dbos-inc/dbos-sdk', async () => (await import('../../../helpers/scripted-waits')).dbosStub);
vi.mock('../../../../src', async () => ({ conditional: (await import('../../../helpers/scripted-waits')).conditional }));

import { WORKFLOW_ID, waits } from '../../../helpers/scripted-waits';
import { machineUnitRoute } from '../../../../examples/machine-line/unit-route';
import { EXAMPLE_LINE, EXAMPLE_STEPS } from '../../../../examples/machine-line/line';
import type { UnitRouteInput } from '../../../../examples/machine-line/route';

const UNITS = [{ unitId: 'U1', carrierId: null }, { unitId: 'U2', carrierId: null }];
const INPUT: UnitRouteInput = { ...EXAMPLE_LINE, routeKey: 'R2', orderRef: 'order-2', units: UNITS, steps: EXAMPLE_STEPS };
const run = (input: Partial<UnitRouteInput> = {}) => machineUnitRoute({ data: { ...INPUT, ...input }, metadata: {}, lt: {} }) as Promise<{ data: any }>;
const RECEIVED = { received: true, $accumulated: [], $trigger: 'resolve' };
const HELD = { received: false, errorCode: 'sender-rejected', result: 'hold', detail: 'seal check', $accumulated: [], $trigger: 'resolve' };
const at = '2026-11-13T00:00:00.000Z';

describe('machineUnitRoute: holds and splits', () => {
  beforeEach(() => waits.reset());

  it('asks the quality role about held units, and release runs the hop again', async () => {
    waits.once('handoff-R2-s1-a1', HELD);
    waits.on(/^hold-/, { decision: 'release' });
    waits.on(/^handoff-R2-/, RECEIVED);
    const { data } = await run();

    expect(data.status).toBe('complete');
    const ask = waits.byKey('hold-R2-s1-a1').config;
    expect(ask).toMatchObject({ role: 'line-quality', type: 'quality-hold', subtype: 'hold', signalKey: 'hold-R2-s1-a1' });
    expect(ask.metadata).toMatchObject({ decisions: ['release', 'rework', 'scrap'], result: 'hold' });
    expect(waits.keys()).toContain('handoff-R2-s1-a2');
  });

  it('sends the decision to the holding machine when the line declares a disposition command', async () => {
    waits.once('handoff-R2-s1-a1', HELD);
    waits.on(/^hold-/, { decision: 'scrap', note: 'seal failed' });
    waits.on(/^disposition-/, { accepted: true });
    waits.on(/^handoff-R2-/, RECEIVED);
    const { data } = await run({ dispositionOp: 'disposition' });

    expect(data).toMatchObject({ status: 'scrapped', at: 'press-01', note: 'seal failed' });
    const sent = waits.byKey('disposition-R2-s1-a1').config;
    expect(sent).toMatchObject({ role: 'line-bond', type: 'machine-command', subtype: 'disposition', signalKey: 'disposition-R2-s1-a1' });
    expect(sent.metadata.args).toEqual({ jobId: 'R2-press-01', unitIds: ['U1', 'U2'], decision: 'scrap', note: 'seal failed' });
  });

  it('reruns the route from the station a rework names, carried from the holding machine', async () => {
    waits.once('handoff-R2-s2-a1', HELD);
    waits.on(/^hold-/, { decision: 'rework', station: 'press-01' });
    waits.on(/^handoff-R2-/, RECEIVED);
    const { data } = await run();

    expect(data.status).toBe('complete');
    expect(waits.keys()).toEqual([
      'handoff-R2-s0-a1', 'handoff-R2-s1-a1', 'handoff-R2-s2-a1', 'hold-R2-s2-a1', 'handoff-R2-s0-a2', 'handoff-R2-s1-a2', 'handoff-R2-s2-a2',
    ]);
    expect(waits.byKey('handoff-R2-s0-a2').config.metadata).toMatchObject({ fromMachine: 'cut-01', toMachine: 'press-01' });
  });

  it('withdraws the receiver\'s job after a partial arrival and has a person collect each group', async () => {
    waits.once('handoff-R2-s1-a1', { $accumulated: [{ itemKey: 'arrived:U2', at }], $trigger: 'timeout' });
    waits.on(/^job-stop-/, { accepted: true });
    waits.on(/^handoff-error-/, { decision: 'manual' });
    waits.on(/^handoff-R2-/, RECEIVED);
    const { data } = await run();

    expect(data).toMatchObject({
      status: 'manual', at: 'press-01', received: true,
      pickups: [{ at: 'cut-01', units: ['U2'], received: true }, { at: 'press-01', units: ['U1'], received: true }],
    });
    expect(waits.byKey('handoff-error-R2-s1-a1').config.metadata.decisions).toEqual(['manual', 'scrap']);
    expect(waits.byKey('job-stop-R2-s1-a1').config.metadata).toMatchObject({ machineId: 'cut-01', op: 'cancel', args: { jobId: 'R2-cut-01' } });
    expect(waits.children).toEqual([`${WORKFLOW_ID}-pickup-3`, `${WORKFLOW_ID}-pickup-4`]);
    expect(waits.byKey('handoff-R2-s3-a1').config).toMatchObject({ subtype: 'pickup', accumulate: {}, signalKey: 'handoff-R2-s3-a1' });
    expect(waits.byKey('handoff-R2-s4-a1').config.metadata).toMatchObject({ pickupAt: 'press-01' });
  });

  it('scraps a split without collecting it when the operator says so', async () => {
    waits.once('handoff-R2-s1-a1', { $accumulated: [{ itemKey: 'arrived:U1', at }], $trigger: 'timeout' });
    waits.on(/^job-stop-/, { accepted: true });
    waits.on(/^handoff-error-/, { decision: 'scrap' });
    waits.on(/^handoff-R2-/, RECEIVED);
    const { data } = await run();

    expect(data.status).toBe('scrapped');
    expect(waits.children).toEqual([]);
  });
});
